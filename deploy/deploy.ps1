<#
Orbis AWS deploy — Lambda + Function URL only.

The Orbis console uses relative API paths (/api/console, /api/health), so it
must share an origin with the API. The Lambda already serves the static console
(server.ts's serveStatic reads apps/console/dist), so ONE Function URL serves
both the console and the API. This is simpler and cheaper than S3 + CloudFront
and matches the code as written.

  .\deploy\deploy.ps1            full deploy (build + zip + Lambda)
  .\deploy\deploy.ps1 -SkipBuild reuse existing dist + zip
  .\deploy\deploy.ps1 -ApiOnly   skip the console dist build step

Idempotent — safe to re-run. Uses the default AWS profile (recall-dev).
#>
param(
  [switch]$ApiOnly,
  [switch]$SkipBuild,
  [string]$Region = "ap-south-1",
  [string]$FunctionName = "orbis-api",
  [string]$StackPrefix = "orbis"
)

$ErrorActionPreference = "Continue"
$aws = "C:\Program Files\Amazon\AWSCLIV2\aws.exe"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

Write-Host ""
Write-Host "=== Orbis AWS deploy ===" -ForegroundColor Cyan
Write-Host "Region: $Region"

# ---------------------------------------------------------------------------
# 0. Account + names
# ---------------------------------------------------------------------------
$identity = & $aws sts get-caller-identity --output json | ConvertFrom-Json
$account = $identity.Account
Write-Host "Account: $account ($($identity.Arn))" -ForegroundColor Green

$apiName    = "$StackPrefix-api"
$roleName   = "$StackPrefix-lambda-role"
$secretName = "$StackPrefix/cloud-db"
$zipPath    = Join-Path $root "deploy\orbis-api.zip"

# ---------------------------------------------------------------------------
# 1. Secrets Manager - Cloud connection string + CA cert
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "--- Secrets Manager ---" -ForegroundColor Cyan

$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) { throw ".env not found - set CLOUD_DATABASE_URL first" }
$cloudUrl = $null
foreach ($line in (Get-Content $envFile)) {
  if ($line -match '^CLOUD_DATABASE_URL=(.+)$') { $cloudUrl = $Matches[1].Trim(); break }
}
if (-not $cloudUrl) { throw "CLOUD_DATABASE_URL missing in .env" }

$certPath = Join-Path $root "certs\root.crt"
if (-not (Test-Path $certPath)) { throw "certs/root.crt not found" }
$certB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($certPath))

$secretJson = (@{ CLOUD_DATABASE_URL = $cloudUrl; ROOT_CRT_B64 = $certB64 } | ConvertTo-Json -Compress)

# Write BOM-free and pass via file:// so PowerShell cannot strip the JSON
# quotes (an inline arg would store {KEY:value} without quotes, breaking
# JSON.parse in the Lambda's bootstrapEnv).
$secretFile = Join-Path $env:TEMP "orbis-secret.json"
[IO.File]::WriteAllText($secretFile, $secretJson)
$secretFileForCli = $secretFile.Replace('\','/')

$secretExists = $false
try { & $aws secretsmanager describe-secret --secret-id $secretName --output json 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { $secretExists = $true } } catch {}
if ($secretExists) {
  Write-Host "Secret $secretName exists - updating" -ForegroundColor DarkGray
  & $aws secretsmanager put-secret-value --secret-id $secretName --secret-string "file://$secretFileForCli" | Out-Null
} else {
  Write-Host "Creating secret $secretName" -ForegroundColor DarkGray
  & $aws secretsmanager create-secret --name $secretName --secret-string "file://$secretFileForCli" | Out-Null
}
Write-Host "Cloud DB URL + cert stored in Secrets Manager" -ForegroundColor Green

# ---------------------------------------------------------------------------
# 2. IAM role + policy for Lambda
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "--- IAM role ---" -ForegroundColor Cyan

$trustPolicy = @{
  Version = "2012-10-17"
  Statement = @(@{
    Effect = "Allow"
    Principal = @{ Service = "lambda.amazonaws.com" }
    Action = "sts:AssumeRole"
  })
} | ConvertTo-Json -Depth 5

$roleArn = $null
try { $roleArn = (& $aws iam get-role --role-name $roleName --query 'Role.Arn' --output text 2>$null) } catch {}
if (-not $roleArn) {
  # Pass JSON via file://. Must be written WITHOUT a BOM: Windows PowerShell's
  # Set-Content -Encoding UTF8 emits a BOM, and AWS's JSON parser rejects it.
  $trustFile = Join-Path $env:TEMP "orbis-trust-policy.json"
  [IO.File]::WriteAllText($trustFile, $trustPolicy)
  & $aws iam create-role --role-name $roleName --assume-role-policy-document "file://$($trustFile.Replace('\','/'))" | Out-Null
  $roleArn = (& $aws iam get-role --role-name $roleName --query 'Role.Arn' --output text).Trim()
  Write-Host "Created role $roleName" -ForegroundColor DarkGray
} else {
  Write-Host "Role $roleName exists" -ForegroundColor DarkGray
}

$policyDoc = @{
  Version = "2012-10-17"
  Statement = @(
    @{
      Effect = "Allow"
      Action = @("logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents")
      Resource = "*"
    },
    @{
      Effect = "Allow"
      Action = "secretsmanager:GetSecretValue"
      Resource = "arn:aws:secretsmanager:${Region}:${account}:secret:${secretName}*"
    },
    @{
      Effect = "Allow"
      Action = "bedrock:InvokeModel"
      Resource = "*"
    }
  )
}
$policyJson = $policyDoc | ConvertTo-Json -Depth 6
$policyFile = Join-Path $env:TEMP "orbis-lambda-policy.json"
[IO.File]::WriteAllText($policyFile, $policyJson)
& $aws iam put-role-policy --role-name $roleName --policy-name "$StackPrefix-lambda-policy" --policy-document "file://$($policyFile.Replace('\','/'))" | Out-Null
Write-Host "Attached Lambda policy (logs, secrets, bedrock)" -ForegroundColor Green

# ---------------------------------------------------------------------------
# 3. Build the API zip
# ---------------------------------------------------------------------------
# -SkipBuild reuses the existing zip. -ApiOnly rebuilds the bundle but skips
# the console's vite build, which is the slow part when only server code has
# changed. Previously the outer condition excluded -ApiOnly too, so it silently
# reused a stale zip and redeployed unchanged code — the flag did the opposite
# of what its own help text promised.
if (-not $SkipBuild) {
  Write-Host ""
  Write-Host "--- Building API bundle ---" -ForegroundColor Cyan

  # Build the console first so its dist is baked into the Lambda bundle.
  if (-not $ApiOnly) {
    Write-Host "Building console (vite build)" -ForegroundColor DarkGray
    Push-Location (Join-Path $root "apps\console")
    npm run build 2>&1 | Out-Null
    Pop-Location
  }

  $buildDir = Join-Path $env:TEMP "orbis-lambda-build"
  if (Test-Path $buildDir) { Remove-Item $buildDir -Recurse -Force }
  New-Item -ItemType Directory -Path $buildDir -Force | Out-Null

  foreach ($d in @("packages","services","scripts","db","certs","apps")) {
    $src = Join-Path $root $d
    $dst = Join-Path $buildDir $d
    if (Test-Path $src) { Copy-Item $src $dst -Recurse -Force }
  }
  Copy-Item (Join-Path $root "package.json") $buildDir
  Copy-Item (Join-Path $root "package-lock.json") $buildDir

  # Root entry point. The handler is configured as `index.handler`, so Lambda
  # looks for index.mjs at the bundle root and nowhere else — without this the
  # function fails at INIT with "Cannot find module 'index'" no matter how
  # complete the rest of the bundle is.
  #
  # It re-exports rather than containing logic because Node 22 strips types on
  # import, so the real handler can stay in TypeScript alongside the code it
  # shares with the local server.
  $indexMjs = @"
// Generated by deploy/deploy.ps1 — do not edit.
// Lambda resolves `index.handler` against this file at the bundle root.
export { handler } from './services/api/lambda.ts';
"@
  [IO.File]::WriteAllText((Join-Path $buildDir "index.mjs"), $indexMjs)

  # node_modules: copy only what Lambda needs.
  #
  # The on-device embedder now ships. It was previously excluded on the
  # assumption that onnxruntime plus transformers is ~350MB, which is true only
  # of the unpruned tree: onnxruntime-node carries prebuilt binaries for win32
  # (124MB) and darwin (35MB) that are dead weight on Lambda, and the fp32
  # model is 87MB where the quantized one is 22MB for measurably identical
  # retrieval. Pruned, the whole embedder is about 85MB, and Lambda's real
  # ceiling is 250MB unzipped when the package is delivered via S3.
  #
  # This is what makes the deployed demo genuinely semantic without Bedrock.
  # @img is NOT excluded. transformers.js declares sharp as a hard dependency
  # (not optional), so `require('sharp')` runs at import even though Orbis only
  # ever embeds text and never touches an image. Shipping only the Windows
  # binary made the on-device embedder fail at load with "Could not load the
  # sharp module using the linux-x64 runtime", which selection then reported —
  # correctly — as no semantic model being available.
  $excludeDirs = @(
    "onnxruntime-web","@oxc-project","@oxlint","@rolldown",
    "typescript","vite","react","react-dom","scheduler","@types","@vitejs"
  )
  $srcNm = Join-Path $root "node_modules"
  $dstNm = Join-Path $buildDir "node_modules"
  New-Item -ItemType Directory -Path $dstNm -Force | Out-Null
  Get-ChildItem $srcNm -Directory | Where-Object { $excludeDirs -notcontains $_.Name } | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $dstNm $_.Name) -Recurse -Force
  }
  Get-ChildItem $srcNm -File | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $dstNm $_.Name) -Force
  }

  # Same treatment for sharp, but only for the platform-specific packages.
  #
  # Not every @img package is a native binary: @img/colour is plain JavaScript
  # that sharp requires unconditionally. Pruning everything without "linux-x64"
  # in the name removed it and moved the failure from "could not load sharp" to
  # "cannot find module '@img/colour'". Match on the sharp- prefix so only
  # binary variants for other platforms are dropped.
  $imgDir = Join-Path $dstNm "@img"
  if (Test-Path $imgDir) {
    Get-ChildItem $imgDir -Directory |
      Where-Object { $_.Name -like "sharp-*" -and $_.Name -notlike "*linux-x64*" } |
      ForEach-Object { Remove-Item $_.FullName -Recurse -Force }
    $kept = (Get-ChildItem $imgDir -Directory | Select-Object -ExpandProperty Name) -join ", "
    Write-Host "Pruned @img ($kept)" -ForegroundColor DarkGray
  }

  # Drop every onnxruntime binary that is not the one Lambda runs on. This is
  # 159MB of the saving on its own.
  $ortBin = Join-Path $dstNm "onnxruntime-node\bin\napi-v6"
  if (Test-Path $ortBin) {
    Get-ChildItem $ortBin -Directory | Where-Object { $_.Name -ne "linux" } | ForEach-Object {
      Remove-Item $_.FullName -Recurse -Force
    }
    Get-ChildItem (Join-Path $ortBin "linux") -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -ne "x64" } | ForEach-Object { Remove-Item $_.FullName -Recurse -Force }
    Write-Host "Pruned onnxruntime to linux/x64 only" -ForegroundColor DarkGray
  }

  # Stage the quantized model. Bundled rather than downloaded at cold start
  # because /var/task is read-only and a cold start must not depend on
  # reaching huggingface.co.
  $modelSrc = Join-Path $root ".models\Xenova\all-MiniLM-L6-v2"
  $modelDst = Join-Path $buildDir "models\Xenova\all-MiniLM-L6-v2"
  if (Test-Path (Join-Path $modelSrc "onnx\model_quantized.onnx")) {
    New-Item -ItemType Directory -Path (Join-Path $modelDst "onnx") -Force | Out-Null
    foreach ($f in @("config.json","tokenizer.json","tokenizer_config.json")) {
      Copy-Item (Join-Path $modelSrc $f) (Join-Path $modelDst $f) -Force
    }
    Copy-Item (Join-Path $modelSrc "onnx\model_quantized.onnx") (Join-Path $modelDst "onnx") -Force
    Write-Host "Bundled quantized MiniLM (22MB)" -ForegroundColor DarkGray
  } else {
    Write-Warning "model_quantized.onnx not found - run: node scripts/fetch-model.mjs"
  }

  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  # tar, not Compress-Archive. Compress-Archive silently omits deeply nested
  # paths, which produced a bundle that looked fine and was missing files at
  # runtime. tar's ./-prefixed entries are normalised by Lambda without issue.
  # Resolve Windows' bsdtar by absolute path. A bare `tar` picks up whatever is
  # first on PATH, and when this script is launched from a shell that puts Git
  # Bash ahead of System32 that is GNU tar — which reads the "D:" in an absolute
  # destination as a remote host and fails with "Cannot connect to D: resolve
  # failed". The zip is then missing, and the next step reports it as though
  # -SkipBuild had been passed.
  $tar = Join-Path $env:SystemRoot "System32\tar.exe"
  if (-not (Test-Path $tar)) { $tar = "tar" }
  Push-Location $buildDir
  & $tar -a -c -f $zipPath *
  Pop-Location

  $zipMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
  Write-Host "API zip: $zipPath ($zipMb MB)" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 4. Lambda function + Function URL
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "--- Lambda ---" -ForegroundColor Cyan
if (-not (Test-Path $zipPath)) { throw "API zip missing - run without -SkipBuild" }

$handler = "index.handler"

# Anything over 50MB cannot be sent inline with --zip-file and has to go via
# S3. The bundle carries a 22MB model and a 53MB ONNX runtime, so it always
# does. The unzipped ceiling is 250MB and this lands around 94MB.
$zipBytes = (Get-Item $zipPath).Length
$useS3 = $zipBytes -gt 50MB
$codeArgs = @()

if ($useS3) {
  $bucket = "$StackPrefix-deploy-$account"
  $key    = "orbis-api-$(Get-Date -Format 'yyyyMMddHHmmss').zip"
  $exists = $true
  try { & $aws s3api head-bucket --bucket $bucket 2>$null | Out-Null } catch { $exists = $false }
  if ($LASTEXITCODE -ne 0) { $exists = $false }
  if (-not $exists) {
    Write-Host "Creating deploy bucket $bucket" -ForegroundColor DarkGray
    & $aws s3api create-bucket --bucket $bucket --region $Region `
      --create-bucket-configuration "LocationConstraint=$Region" 2>$null | Out-Null
  }
  Write-Host "Uploading bundle to s3://$bucket/$key" -ForegroundColor DarkGray
  & $aws s3 cp $zipPath "s3://$bucket/$key" --region $Region | Out-Null
  $codeArgs = @("--code", "S3Bucket=$bucket,S3Key=$key")
} else {
  $codeArgs = @("--zip-file", "fileb://$zipPath")
}

# Environment via file to avoid PowerShell mangling inline JSON. AWS_REGION is
# a reserved Lambda key and cannot be set; the SDK reads it automatically.
#
# ORBIS_EMBEDDER is deliberately NOT pinned to bedrock. Pinning it made
# selection try exactly one provider, and when Bedrock returned "Operation not
# allowed" there was nothing left to fall through to but the lexical stub —
# which is how the deployed demo ended up with keyword-only search. Left unset,
# selection probes bedrock, then the bundled on-device model, then lexical, so
# Bedrock becomes an upgrade that applies itself the moment the account is
# unblocked.
$envVars = @{
  ORBIS_TARGET        = "cloud"
  ORBIS_DEV           = "1"
  BEDROCK_EMBED_MODEL = "amazon.titan-embed-text-v2:0"
  ORBIS_MODEL_DIR     = "/var/task/models"
  ORBIS_MODEL_DTYPE   = "q8"
}
$envJson = @{ Variables = $envVars } | ConvertTo-Json -Depth 4
$envFile = Join-Path $env:TEMP "orbis-lambda-env.json"
[IO.File]::WriteAllText($envFile, $envJson)

$lambdaArn = $null
try { $lambdaArn = (& $aws lambda get-function --function-name $apiName --query 'Configuration.FunctionArn' --output text 2>$null) } catch {}

if (-not $lambdaArn) {
  Write-Host "Creating Lambda $apiName" -ForegroundColor DarkGray
  if ($useS3) {
    & $aws lambda create-function --function-name $apiName --runtime nodejs22.x `
      --role $roleArn --handler $handler `
      --code "S3Bucket=$bucket,S3Key=$key" `
      --environment "file://$($envFile.Replace('\','/'))" `
      --timeout 60 --memory-size 2048 --region $Region | Out-Null
  } else {
    & $aws lambda create-function --function-name $apiName --runtime nodejs22.x `
      --role $roleArn --handler $handler `
      --zip-file "fileb://$zipPath" `
      --environment "file://$($envFile.Replace('\','/'))" `
      --timeout 60 --memory-size 2048 --region $Region | Out-Null
  }
  $lambdaArn = (& $aws lambda get-function --function-name $apiName --query 'Configuration.FunctionArn' --output text).Trim()
} else {
  Write-Host "Lambda $apiName exists - updating code" -ForegroundColor DarkGray
  if ($useS3) {
    & $aws lambda update-function-code --function-name $apiName `
      --s3-bucket $bucket --s3-key $key --region $Region | Out-Null
  } else {
    & $aws lambda update-function-code --function-name $apiName `
      --zip-file "fileb://$zipPath" --region $Region | Out-Null
  }

  # A code update must finish before a configuration update is accepted.
  & $aws lambda wait function-updated --function-name $apiName --region $Region 2>$null | Out-Null

  Write-Host "Updating Lambda configuration" -ForegroundColor DarkGray
  # More memory because the ONNX session needs headroom, and Lambda scales CPU
  # with memory: at 1024MB the model load is noticeably slower than it needs to
  # be, and cold start is the one number a judge will feel.
  & $aws lambda update-function-configuration --function-name $apiName `
    --environment "file://$($envFile.Replace('\','/'))" `
    --timeout 60 --memory-size 2048 --region $Region | Out-Null
  & $aws lambda wait function-updated --function-name $apiName --region $Region 2>$null | Out-Null
}
Write-Host "Lambda ready: $lambdaArn" -ForegroundColor Green

# ---------------------------------------------------------------------------
# Public front door: API Gateway HTTP API.
#
# Function URLs return 403 for every invocation in this AWS account even with
# NONE auth and a correct resource policy (account-level restriction, likely
# an SCP or new-account hold). API Gateway HTTP API works reliably, so it is
# the public door. The console uses relative paths, so serving the console
# from the Lambda behind API Gateway keeps the same origin.
# ---------------------------------------------------------------------------
$gwApiName = "orbis-api"
$gwApiId = $null
$gwEndpoint = $null

# Create if absent.
$gwList = & $aws apigatewayv2 get-apis --region $Region --output json 2>$null | ConvertFrom-Json
if ($gwList.Items) {
  $existing = $gwList.Items | Where-Object { $_.Name -eq $gwApiName } | Select-Object -First 1
  if ($existing) { $gwApiId = $existing.ApiId; $gwEndpoint = $existing.ApiEndpoint }
}
if (-not $gwApiId) {
  $gw = & $aws apigatewayv2 create-api --name $gwApiName --protocol-type HTTP --target $lambdaArn --route-key '$default' --region $Region --output json 2>$null | ConvertFrom-Json
  $gwApiId = $gw.ApiId
  $gwEndpoint = $gw.ApiEndpoint
}
Write-Host "API Gateway: $gwEndpoint (id $gwApiId)" -ForegroundColor Green

# Grant API Gateway permission to invoke the Lambda. Use a stable statement
# id; if it already exists this is a no-op error we can ignore.
$gwPerm = "arn:aws:execute-api:${Region}:${account}:${gwApiId}/*/*"
& $aws lambda add-permission `
  --function-name $apiName `
  --statement-id "APIGatewayInvoke" `
  --action "lambda:InvokeFunction" `
  --principal "apigateway.amazonaws.com" `
  --source-arn $gwPerm `
  --region $Region 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "API Gateway permission already granted" -ForegroundColor DarkGray }

Write-Host ""
Write-Host "=== TEST: $($gwEndpoint)/api/health ===" -ForegroundColor Yellow
try {
  $h = Invoke-WebRequest -Uri "$($gwEndpoint)/api/health" -UseBasicParsing -TimeoutSec 30
  Write-Host "Health: $($h.StatusCode) $($h.Content)" -ForegroundColor Green
} catch {
  Write-Host "Health check failed (may still be warming up): $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== Deploy complete ===" -ForegroundColor Green
Write-Host "Console + API: $gwEndpoint"
Write-Host "MCP endpoint:  $($gwEndpoint)/api/mcp"
Write-Host ""
Write-Host "Note: the console is served by the Lambda behind API Gateway (same origin)."
