// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a move edit recorded, as [old, new], for the R output line (section 2). */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileText {
  lines: string[];
  br: string;
  ends: boolean;
}

function parseFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function serializeFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

const stripLead = (s: string): string => s.replace(/^[ \t]+/, '');
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');

/** Line equality at a tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripLead(stripTrail(a)) === stripLead(stripTrail(b));
}

/** All start positions where O occurs in the file's lines at a tier. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0..2, or 0 only when strict) where O occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier++) {
    const positions = occurrences(lines, o, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of a hunk or chunk body: context (both), old (removed) or new (added). */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}

const oldLinesOf = (body: BodyLine[]): string[] => body.filter((b) => b.kind !== 'new').map((b) => b.text);

/**
 * Build the replacement lines for an occurrence of O at pos: context lines are the file's own matched lines,
 * and at tier 2 every other (new) line is re-indented from O's first line to the file's first matched line.
 */
function buildReplacement(body: BodyLine[], fileLines: string[], pos: number, tier: number): string[] {
  const o = oldLinesOf(body);
  const oCtxAt: number[] = [];
  let oi = 0;
  for (const b of body) {
    if (b.kind === 'new') continue;
    if (b.kind === 'ctx') oCtxAt.push(oi);
    oi += 1;
  }
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = /^[ \t]*/.exec(fileLines[pos]!)![0];
    p = /^[ \t]*/.exec(o[0]!)![0];
  }
  const out: string[] = [];
  let ctxCount = 0;
  for (const b of body) {
    if (b.kind === 'old') continue;
    if (b.kind === 'ctx') {
      out.push(fileLines[pos + oCtxAt[ctxCount]!]!);
      ctxCount += 1;
      continue;
    }
    let t = b.text;
    if (tier === 2 && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** SPEC.md section 6: unified diffs. */

interface Hunk {
  a: number;
  body: BodyLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noBreakAtEnd: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noBreakAfterPlus: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function parseHeaderPath(text: string): string {
  let t = text;
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  return t.trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function applyHunks(fileText: string, hunks: Hunk[], strict: boolean, path: string): string {
  let f = parseFile(fileText);
  let d = 0;
  for (const hunk of hunks) {
    const o = oldLinesOf(hunk.body);
    if (o.length === 0) {
      const ins = Math.min(hunk.a + d, f.lines.length);
      const n = hunk.body.filter((b) => b.kind === 'new').map((b) => b.text);
      const newLines = [...f.lines.slice(0, ins), ...n, ...f.lines.slice(ins)];
      let newEnds = f.ends;
      if (ins === f.lines.length) newEnds = !hunk.noBreakAfterPlus;
      f = { lines: newLines, br: f.br, ends: newEnds };
      d += n.length;
    } else {
      const found = findTier(f.lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.positions) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) { best = pos; bestDist = dist; }
      }
      const pos = best;
      const nPrime = buildReplacement(hunk.body, f.lines, pos, found.tier);
      const newLines = [...f.lines.slice(0, pos), ...nPrime, ...f.lines.slice(pos + o.length)];
      let newEnds = f.ends;
      if (pos + o.length === f.lines.length) newEnds = !hunk.noBreakAtEnd;
      f = { lines: newLines, br: f.br, ends: newEnds };
      d += nPrime.length - o.length;
    }
  }
  return serializeFile(f);
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  return (tree: Tree) => {
    const isCreate = sec.oldPath === null || sec.newFile;
    const isDelete = sec.newPath === null || sec.deletedFile;
    if (isCreate) {
      const p = sec.newPath;
      if (p === null) throw new Fail('missing', '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plusLines: string[] = [];
      for (const h of sec.hunks) {
        for (const b of h.body) if (b.kind === 'new') plusLines.push(b.text);
      }
      let ends = true;
      if (plusLines.length === 0) ends = false;
      else {
        for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
          const h = sec.hunks[hi]!;
          if (h.body.some((b) => b.kind === 'new')) { ends = !h.noBreakAfterPlus; break; }
        }
      }
      tree.now.set(p, plusLines.length === 0 ? '' : plusLines.join('\n') + (ends ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const p = sec.oldPath;
      if (p === null) throw new Fail('missing', '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = sec.oldPath!;
    const newP = sec.newPath!;
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(before, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push([oldP, newP]);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyHunks(before, sec.hunks, strict, oldP));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  const n = lines.length;
  let cur: Section | null = null;
  let mode: 'outside' | 'header' | 'body' | 'trailing' = 'outside';
  let headerHasPaths = false;
  let hunkA = 0;
  let rawLines: string[] = [];

  const parseHunkHeader = (line: string, lineNo: number): number => {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m === null) throw new Exit2(`error: parse ${lineNo}`);
    return parseInt(m[1]!, 10);
  };

  const parseDiffGit = (line: string, lineNo: number): [string, string] => {
    const rest = line.slice('diff --git '.length);
    if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${lineNo}`);
    const sep = rest.indexOf(' b/');
    if (sep < 0) throw new Exit2(`error: parse ${lineNo}`);
    return [rest.slice(2, sep), rest.slice(sep + 3)];
  };

  const finishHunk = (): void => {
    if (cur === null) return;
    while (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
    let noBreakAtEnd = false;
    let noBreakAfterPlus = false;
    let lastCtxPlus = -1;
    let lastPlus = -1;
    rawLines.forEach((rl, idx) => {
      if (rl.startsWith(' ') || rl.startsWith('+') || rl === '') lastCtxPlus = idx;
      if (rl.startsWith('+')) lastPlus = idx;
    });
    if (lastCtxPlus >= 0 && rawLines[lastCtxPlus + 1] !== undefined && rawLines[lastCtxPlus + 1]!.startsWith('\\')) noBreakAtEnd = true;
    if (lastPlus >= 0 && rawLines[lastPlus + 1] !== undefined && rawLines[lastPlus + 1]!.startsWith('\\')) noBreakAfterPlus = true;
    const body: BodyLine[] = [];
    for (const rl of rawLines) {
      if (rl.startsWith(' ')) body.push({ kind: 'ctx', text: rl.slice(1) });
      else if (rl.startsWith('-')) body.push({ kind: 'old', text: rl.slice(1) });
      else if (rl.startsWith('+')) body.push({ kind: 'new', text: rl.slice(1) });
      else if (rl === '') body.push({ kind: 'ctx', text: '' });
    }
    cur.hunks.push({ a: hunkA, body, noBreakAtEnd, noBreakAfterPlus });
    rawLines = [];
  };

  const finishSection = (): void => {
    if (cur === null) return;
    if (mode === 'body') finishHunk();
    sections.push(cur);
    cur = null;
    mode = 'outside';
  };

  const startFromDiffGit = (line: string, lineNo: number): void => {
    const [x, y] = parseDiffGit(line, lineNo);
    cur = { oldPath: x, newPath: y, newFile: false, deletedFile: false, hunks: [] };
    mode = 'header';
    headerHasPaths = false;
  };

  const startFromPair = (dashLine: string, plusLine: string): void => {
    const oldRaw = parseHeaderPath(dashLine.slice(4));
    const newRaw = parseHeaderPath(plusLine.slice(4));
    cur = {
      oldPath: oldRaw === '/dev/null' ? null : stripAB(oldRaw),
      newPath: newRaw === '/dev/null' ? null : stripAB(newRaw),
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    mode = 'header';
    headerHasPaths = true;
  };

  while (i < n) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (mode === 'outside') {
      if (line.startsWith('diff --git ')) {
        startFromDiffGit(line, lineNo);
        i += 1;
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startFromPair(line, lines[i + 1]!);
        i += 2;
      } else if (line.startsWith('@@')) {
        throw new Exit2(`error: parse ${lineNo}`);
      } else {
        i += 1;
      }
    } else if (mode === 'header') {
      if (line.startsWith('@@')) {
        hunkA = parseHunkHeader(line, lineNo);
        rawLines = [];
        mode = 'body';
        i += 1;
      } else if (line.startsWith('--- ')) {
        if (!headerHasPaths) {
          if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${lineNo + 1}`);
          const oldRaw = parseHeaderPath(line.slice(4));
          const newRaw = parseHeaderPath(lines[i + 1]!.slice(4));
          cur!.oldPath = oldRaw === '/dev/null' ? null : stripAB(oldRaw);
          cur!.newPath = newRaw === '/dev/null' ? null : stripAB(newRaw);
          headerHasPaths = true;
          i += 2;
        } else {
          finishSection();
          startFromPair(line, lines[i + 1]!);
          i += 2;
        }
      } else if (line.startsWith('diff --git ')) {
        finishSection();
        startFromDiffGit(line, lineNo);
        i += 1;
      } else {
        // rename from/to name the paths only when no ---/+++ pair does (section 6)
        if (line.startsWith('rename from ') && !headerHasPaths) cur!.oldPath = line.slice('rename from '.length).trim();
        else if (line.startsWith('rename to ') && !headerHasPaths) cur!.newPath = line.slice('rename to '.length).trim();
        else if (line.startsWith('new file mode')) cur!.newFile = true;
        else if (line.startsWith('deleted file mode')) cur!.deletedFile = true;
        i += 1;
      }
    } else if (mode === 'body') {
      if (line.startsWith('@@')) {
        finishHunk();
        hunkA = parseHunkHeader(line, lineNo);
        rawLines = [];
        i += 1;
      } else if (line.startsWith('diff --git ')) {
        finishSection();
        startFromDiffGit(line, lineNo);
        i += 1;
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        finishSection();
        startFromPair(line, lines[i + 1]!);
        i += 2;
      } else if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        rawLines.push(line);
        i += 1;
      } else {
        finishHunk();
        mode = 'trailing';
      }
    } else {
      if (line.startsWith('@@')) {
        hunkA = parseHunkHeader(line, lineNo);
        rawLines = [];
        mode = 'body';
        i += 1;
      } else if (line.startsWith('diff --git ')) {
        finishSection();
        startFromDiffGit(line, lineNo);
        i += 1;
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        finishSection();
        startFromPair(line, lines[i + 1]!);
        i += 2;
      } else {
        i += 1;
      }
    }
  }
  finishSection();
  return sections.map((sec) => sectionEdit(sec, strict));
}

/** SPEC.md section 7: SEARCH/REPLACE blocks. */

function srEdits(lines: string[], strict: boolean): Edit[] {
  const isSearch = (l: string): boolean => l.trimEnd() === '<<<<<<< SEARCH';
  const isSep = (l: string): boolean => l.trimEnd() === '=======';
  const isEnd = (l: string): boolean => l.trimEnd() === '>>>>>>> REPLACE';
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1; // index of the previous block's REPLACE line
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (!isSearch(lines[i]!)) { i += 1; continue; }
    const s = i;
    // Path: nearest line before SEARCH, after the previous block's REPLACE, not blank and not starting with ```.
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    // Find ======= then >>>>>>> REPLACE.
    let sep = -1;
    let end = -1;
    for (let j = s + 1; j < n; j++) {
      if (isSearch(lines[j]!)) break;
      if (sep < 0 && isSep(lines[j]!)) { sep = j; continue; }
      if (sep >= 0 && isEnd(lines[j]!)) { end = j; break; }
    }
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = parseFile(before);
      const found = findTier(f.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const body: BodyLine[] = [
        ...oldLines.map((t) => ({ kind: 'old' as const, text: t })),
        ...newLines.map((t) => ({ kind: 'new' as const, text: t })),
      ];
      const nPrime = buildReplacement(body, f.lines, pos, found.tier);
      const newLinesOut = [...f.lines.slice(0, pos), ...nPrime, ...f.lines.slice(pos + oldLines.length)];
      tree.now.set(p, serializeFile({ lines: newLinesOut, br: f.br, ends: f.ends }));
    });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

/** SPEC.md section 8: V4A patches. */

function findTierFrom(lines: string[], o: string[], from: number, strict: boolean): { tier: number; pos: number } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier++) {
    const positions = occurrences(lines, o, tier).filter((pos) => pos >= from);
    if (positions.length > 0) return { tier, pos: positions[0]! };
  }
  return null;
}

function findTierEof(lines: string[], o: string[], from: number, strict: boolean): { tier: number; pos: number } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier++) {
    const positions = occurrences(lines, o, tier).filter((pos) => pos >= from && pos + o.length === lines.length);
    if (positions.length > 0) return { tier, pos: positions[0]! };
  }
  return null;
}

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) { last = k; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i += 1;
    if (i >= last) break;
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      const raw: string[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) { raw.push(lines[j]!); j += 1; }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const rl = raw[k]!;
        if (rl.startsWith('+')) fileLines.push(rl.slice(1));
        else if (rl === '') fileLines.push('');
        else throw new Exit2(`error: parse ${i + 1 + k + 1}`);
      }
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      i = j;
    } else if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      const raw: string[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) { raw.push(lines[j]!); j += 1; }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const bad = raw.findIndex((rl) => !blank(rl));
      if (bad >= 0) throw new Exit2(`error: parse ${i + 1 + bad + 1}`);
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      i = j;
    } else if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      const updateLineNo = i + 1;
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j += 1;
      }
      const raw: string[] = [];
      const rawStart = j;
      while (j < last && !isSectionStart(lines[j]!)) { raw.push(lines[j]!); j += 1; }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const chunks: VChunk[] = [];
      let k = 0;
      let firstChunk = true;
      let inChunk = false;
      let anchor: string | null = null;
      let body: BodyLine[] = [];
      let eof = false;
      const pushChunk = (): void => {
        if (!inChunk) return;
        chunks.push({ anchor, body, eof });
        inChunk = false;
        body = [];
        eof = false;
        anchor = null;
      };
      while (k < raw.length) {
        const rl = raw[k]!;
        const rlNo = rawStart + k + 1;
        if (rl.startsWith('@@')) {
          pushChunk();
          anchor = rl.slice(2).trim();
          if (anchor === '') anchor = null;
          inChunk = true;
          firstChunk = false;
          k += 1;
        } else if (rl === '*** End of File') {
          if (!inChunk) throw new Exit2(`error: parse ${rlNo}`);
          eof = true;
          pushChunk();
          firstChunk = false;
          k += 1;
        } else if (rl.startsWith(' ') || rl === '' || rl.startsWith('-') || rl.startsWith('+')) {
          if (!inChunk) {
            if (!firstChunk) throw new Exit2(`error: parse ${rlNo}`);
            anchor = null;
            inChunk = true;
            firstChunk = false;
          }
          if (rl.startsWith(' ')) body.push({ kind: 'ctx', text: rl.slice(1) });
          else if (rl === '') body.push({ kind: 'ctx', text: '' });
          else if (rl.startsWith('-')) body.push({ kind: 'old', text: rl.slice(1) });
          else body.push({ kind: 'new', text: rl.slice(1) });
          k += 1;
        } else {
          throw new Exit2(`error: parse ${rlNo}`);
        }
      }
      pushChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (moveTo !== null) {
          if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
          if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        }
        let f = parseFile(before);
        let cursor = 0;
        for (const chunk of chunks) {
          if (chunk.anchor !== null) {
            const a = findTierFrom(f.lines, [chunk.anchor], cursor, strict);
            if (a === null) throw new Fail('no-match', p);
            cursor = a.pos + 1;
          }
          const o = oldLinesOf(chunk.body);
          if (o.length === 0) {
            const ins = chunk.eof ? f.lines.length : cursor;
            const add = chunk.body.filter((b) => b.kind === 'new').map((b) => b.text);
            const newLines = [...f.lines.slice(0, ins), ...add, ...f.lines.slice(ins)];
            f = { lines: newLines, br: f.br, ends: f.ends };
            cursor = ins + add.length;
          } else {
            const found = chunk.eof ? findTierEof(f.lines, o, cursor, strict) : findTierFrom(f.lines, o, cursor, strict);
            if (found === null) throw new Fail('no-match', p);
            const pos = found.pos;
            const nPrime = buildReplacement(chunk.body, f.lines, pos, found.tier);
            const newLines = [...f.lines.slice(0, pos), ...nPrime, ...f.lines.slice(pos + o.length)];
            f = { lines: newLines, br: f.br, ends: f.ends };
            cursor = pos + nPrime.length;
          }
        }
        const out = serializeFile(f);
        if (moveTo !== null) {
          tree.now.set(p, null);
          tree.now.set(moveTo, out);
          tree.moves.push([p, moveTo]);
        } else {
          tree.now.set(p, out);
        }
      });
      i = j;
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: a move edit that succeeded becomes one R line (section 2) instead of its D and A pair.
  const entries: { key: string; line: string }[] = [];
  const suppressed = new Set<string>();
  const seenMove = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const k = `${oldP}\0${newP}`;
    if (seenMove.has(k)) continue;
    seenMove.add(k);
    const oldWas = tree.original(oldP);
    const oldNow = tree.now.has(oldP) ? tree.now.get(oldP)! : tree.original(oldP);
    const newWas = tree.original(newP);
    const newNow = tree.now.has(newP) ? tree.now.get(newP)! : tree.original(newP);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      suppressed.add(oldP);
      suppressed.add(newP);
      entries.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  for (const p of tree.now.keys()) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
