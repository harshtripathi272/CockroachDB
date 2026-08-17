#!/usr/bin/env node
/**
 * Fetch the quantized MiniLM weights into .models/ so the deploy script can
 * bundle them.
 *
 * Quantized rather than fp32 because it is 22MB against 87MB for measurably
 * identical retrieval — 5/5 top-1 either way, and a margin to the runner-up of
 * 0.165 against 0.166. That difference is noise; the size difference is what
 * decides whether the embedder fits in a Lambda package at all.
 */
import { pipeline, env } from '@huggingface/transformers';

env.cacheDir = './.models';

console.log('fetching Xenova/all-MiniLM-L6-v2 (q8)…');
const t0 = Date.now();
const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
const out = await extractor('verification sentence', { pooling: 'mean', normalize: true });
console.log(`ready in ${Date.now() - t0}ms, ${out.data.length} dimensions`);
console.log('cached under .models/Xenova/all-MiniLM-L6-v2/');
