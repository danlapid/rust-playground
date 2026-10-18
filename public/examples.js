// The page's examples. scripts/warm-cache.mjs builds the dependencies of each one that has
// them, and scripts/record-run.mjs records the first one's first build.
export const EXAMPLES = [
  {
    name: 'Crates: serde + rand',
    code: `---
[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
rand = "0.9"
---
// Dependencies come from crates.io: resolved, built in Workers, and cached.
// serde_derive is a proc macro, so it runs in a Dynamic Worker of its own;
// zerocopy's build script runs rustc to check its version.
use rand::{Rng, SeedableRng};
use serde::Serialize;

#[derive(Serialize)]
struct Roll { die: u8, crit: bool }

fn main() {
    let mut rng = rand::rngs::StdRng::seed_from_u64(42);
    let rolls: Vec<Roll> = (0..5)
        .map(|_| {
            let die = rng.random_range(1..=20);
            Roll { die, crit: die == 20 }
        })
        .collect();
    println!("{}", serde_json::to_string_pretty(&rolls).unwrap());
}
`,
  },
  {
    name: 'Hello (std only)',
    code: `use std::collections::BTreeMap;

fn main() {
    let text = "the quick brown fox jumps over the lazy dog the end";
    let mut counts = BTreeMap::new();
    for word in text.split_whitespace() {
        *counts.entry(word).or_insert(0) += 1;
    }
    println!("Hello from a Dynamic Worker! {counts:?}");
}
`,
  },
  {
    name: 'Proc macros: derive both ways',
    code: `---
[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
---
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct Deploy {
    worker_name: String,
    compatibility_date: String,
    #[serde(default)]
    routes: Vec<String>,
}

fn main() {
    let json = r#"{ "workerName": "rust-playground", "compatibilityDate": "2026-10-01" }"#;
    let deploy: Deploy = serde_json::from_str(json).unwrap();
    println!("{deploy:#?}");
    println!("{}", serde_json::to_string(&deploy).unwrap());
}
`,
  },
  {
    name: 'Iterators: itertools',
    code: `---
[dependencies]
itertools = "0.14"
---
use itertools::Itertools;

fn main() {
    let words = ["apple", "avocado", "banana", "blueberry", "cherry"];
    for (letter, mut group) in &words.iter().chunk_by(|w| w.chars().next().unwrap()) {
        println!("{letter}: {}", group.join(", "));
    }
    println!("{}", (1..=4).cartesian_product('a'..='b').map(|(n, c)| format!("{n}{c}")).join(" "));
}
`,
  },
  {
    name: 'Compiler errors',
    code: `// rustc's diagnostics show up in the editor, as they would in VS Code.
fn average(values: &[f64]) -> f64 {
    let total: f64 = values.iter().sum();
    total / values.len()
}

fn main() {
    let scores = vec![3.5, 4.0, 5.0];
    let label: u32 = "average";
    println!("{label}: {}", average(scores));
}
`,
  },
  {
    name: 'Standard input',
    stdin: 'ferris\nwasm\nworkers\n',
    code: `use std::io::{self, BufRead};

fn main() {
    // Edit the lines under "Standard input", below the editor.
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        println!("{line:>10} reversed is {}", line.chars().rev().collect::<String>());
    }
}
`,
  },
  {
    name: 'Panics and exit codes',
    code: `fn parse(s: &str) -> Result<i32, std::num::ParseIntError> {
    s.trim().parse()
}

fn main() {
    let caught = std::panic::catch_unwind(|| {
        let v: Vec<i32> = Vec::new();
        v[3]
    });
    println!("caught a panic: {}", caught.is_err());
    match parse("42") {
        Ok(n) => println!("parsed {n}"),
        Err(e) => eprintln!("{e}"),
    }
    std::process::exit(match parse("nope") { Ok(_) => 0, Err(_) => 3 });
}
`,
  },
];
