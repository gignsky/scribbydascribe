// Dice notation for /roll: parse an expression like `2d20kh1+5` and roll it.
// Pure apart from the random source, which tests replace.

import { randomInt } from 'node:crypto';

export const MAX_DICE = 100; // per term
export const MAX_SIDES = 1000;
export const MAX_TERMS = 20;

/**
 * One term: `NdM` with an optional keep (`kh3`, `kl1`), `d%` for d100, or a
 * plain number. Signs are handled by the caller.
 */
const TERM = /^(?:(\d*)d(\d+|%)(?:(k[hl]?)(\d+))?|(\d+))$/;

/**
 * Parse dice notation into signed terms. Throws with a readable message on
 * anything it cannot roll.
 * @returns {{ sign: 1 | -1, count?: number, sides?: number, keep?: { high: boolean, n: number }, value?: number }[]}
 */
export function parseDice(expr) {
  const src = String(expr).toLowerCase().replace(/\s+/g, '');
  if (!src) throw new Error('Give some dice to roll, like `d20` or `2d6+3`.');
  const parts = src.match(/[+-]?[^+-]+/g);
  if (!parts || parts.join('') !== src) throw new Error(`Could not read \`${expr}\`.`);
  if (parts.length > MAX_TERMS) throw new Error(`At most ${MAX_TERMS} terms, please.`);

  return parts.map((part) => {
    const sign = part.startsWith('-') ? -1 : 1;
    const body = part.replace(/^[+-]/, '');
    const m = TERM.exec(body);
    if (!m) throw new Error(`Could not read \`${body}\`. Try something like \`d20\`, \`3d6+2\` or \`4d6kh3\`.`);
    const [, count, sides, keepKind, keepN, value] = m;
    if (value !== undefined) return { sign, value: Number(value) };

    const term = { sign, count: count === '' ? 1 : Number(count), sides: sides === '%' ? 100 : Number(sides) };
    if (term.count < 1 || term.count > MAX_DICE) throw new Error(`Roll between 1 and ${MAX_DICE} dice at a time.`);
    if (term.sides < 2 || term.sides > MAX_SIDES) throw new Error(`Dice need between 2 and ${MAX_SIDES} sides.`);
    if (keepKind) {
      const n = Number(keepN);
      if (n < 1 || n > term.count) throw new Error(`Can only keep between 1 and ${term.count} of \`${body}\`.`);
      term.keep = { high: keepKind !== 'kl', n };
    }
    return term;
  });
}

/**
 * Roll parsed terms. Each die term records every face rolled and which were
 * kept, so the reply can show its working.
 * @param {(sides: number) => number} die returns 1..sides
 */
export function rollTerms(terms, die = (sides) => randomInt(1, sides + 1)) {
  let total = 0;
  const rolled = terms.map((t) => {
    if (t.value !== undefined) {
      total += t.sign * t.value;
      return { ...t };
    }
    const faces = Array.from({ length: t.count }, () => die(t.sides));
    let kept = faces.map(() => true);
    if (t.keep) {
      // Keep the highest (or lowest) n; ties go to the earlier die.
      const order = faces.map((f, i) => i).sort((a, b) => (t.keep.high ? faces[b] - faces[a] : faces[a] - faces[b]) || a - b);
      const keep = new Set(order.slice(0, t.keep.n));
      kept = faces.map((f, i) => keep.has(i));
    }
    const sum = faces.reduce((n, f, i) => n + (kept[i] ? f : 0), 0);
    total += t.sign * sum;
    return { ...t, faces, kept, sum };
  });
  return { terms: rolled, total };
}

/** The notation back out, normalised: `2d20kh1 + 5`. */
export function notation(terms) {
  return terms
    .map((t, i) => {
      const op = t.sign < 0 ? '-' : '+';
      const body =
        t.value !== undefined ? String(t.value) : `${t.count}d${t.sides}` + (t.keep ? `k${t.keep.high ? 'h' : 'l'}${t.keep.n}` : '');
      return i === 0 ? (t.sign < 0 ? `-${body}` : body) : `${op} ${body}`;
    })
    .join(' ');
}

/** The working, e.g. `[17, ~~4~~] + 5`, with dropped dice struck through. */
export function working(result) {
  return result.terms
    .map((t, i) => {
      const body = t.value !== undefined ? String(t.value) : `[${t.faces.map((f, j) => (t.kept[j] ? `${f}` : `~~${f}~~`)).join(', ')}]`;
      if (i === 0) return t.sign < 0 ? `-${body}` : body;
      return `${t.sign < 0 ? '-' : '+'} ${body}`;
    })
    .join(' ');
}

/** Parse and roll in one go. */
export function roll(expr, die) {
  const terms = parseDice(expr);
  const result = rollTerms(terms, die);
  return { ...result, notation: notation(terms), working: working(result) };
}
