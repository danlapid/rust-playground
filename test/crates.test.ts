import { env } from 'cloudflare:workers';
import { describe, expect, inject, it } from 'vitest';
import { compileAndRun, type PlaygroundResult } from '../src/pipeline';

const stdout = (r: PlaygroundResult) => r.run?.output.filter((o) => o.stream === 'stdout').map((o) => o.text);
const diagnostics = (r: PlaygroundResult) => [r.deps?.diagnostics, r.compile.diagnostics].filter(Boolean).join('\n');

const ITERTOOLS = `---
[dependencies]
itertools = "0.14"
---
use itertools::Itertools;
fn main() {
    println!("{}", (1..=3).interleave(7..=9).join(","));
}
`;

const SERDE = `---
[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
---
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug)]
struct Point { x: i32, y: Option<String> }

fn main() {
    let p: Point = serde_json::from_str(r#"{"x": 1, "y": "two"}"#).unwrap();
    println!("{p:?}");
    println!("{}", serde_json::to_string(&Point { x: 3, y: None }).unwrap());
}
`;

// Fetches from crates.io, and compiles crates with rustc in a Worker.
describe.skipIf(!inject('hasCompiler'))('crates', () => {
  it('builds dependencies from crates.io, then reuses them', async () => {
    const r = await compileAndRun(env, { code: ITERTOOLS });
    expect(diagnostics(r)).not.toMatch(/error/);
    expect(stdout(r)).toEqual(['1,7,2,8,3,9']);
    expect(r.deps?.units.some((u) => u.id.startsWith('itertools@0.14.'))).toBe(true);

    const again = await compileAndRun(env, { code: ITERTOOLS });
    expect(stdout(again)).toEqual(['1,7,2,8,3,9']);
    expect(again.deps?.units.every((u) => u.cached)).toBe(true);
  });

  it('runs build scripts and proc macros', async () => {
    const r = await compileAndRun(env, { code: SERDE });
    expect(diagnostics(r)).not.toMatch(/error/);
    expect(stdout(r)).toEqual(['Point { x: 1, y: Some("two") }', '{"x":3,"y":null}']);
  });

  it('runs build scripts that run rustc', async () => {
    // zerocopy's build script (rand -> rand_chacha -> ppv-lite86 -> zerocopy) needs
    // `rustc --version`; anyhow's compiles probes.
    const r = await compileAndRun(env, {
      code: `---
[dependencies]
rand = "0.9"
anyhow = "1"
---
use rand::{Rng, SeedableRng};
fn main() -> anyhow::Result<()> {
    let mut rng = rand::rngs::StdRng::seed_from_u64(7);
    let n: u32 = rng.random_range(1..=6);
    anyhow::ensure!((1..=6).contains(&n), "out of range");
    println!("ok");
    Ok(())
}
`,
    });
    expect(diagnostics(r)).not.toMatch(/error/);
    expect(stdout(r)).toEqual(['ok']);
  });

  it('reports unknown crates', async () => {
    const r = await compileAndRun(env, { code: '---\n[dependencies]\nno-such-crate-rp-test = "1"\n---\nfn main() {}\n' });
    expect(r.stage).toBe('deps');
    expect(r.deps?.diagnostics).toMatch(/no-such-crate-rp-test/);
  });
});
