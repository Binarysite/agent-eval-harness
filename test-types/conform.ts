// Fails `npm run typecheck` when index.d.ts promises something src/index.js
// does not provide (a missing export, a different signature).
import * as impl from '../src/index.js';
import type * as decl from '../index.js';

export const conforms: typeof decl = impl;
