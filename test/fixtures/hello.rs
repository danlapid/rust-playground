use std::collections::HashMap;

fn main() {
    let mut counts = HashMap::new();
    for w in "the quick brown fox jumps over the lazy dog the end".split(' ') {
        *counts.entry(w).or_insert(0) += 1;
    }
    println!("Hello from Rust on Workers! the={}", counts["the"]);
    println!("args={:?}", std::env::args().skip(1).collect::<Vec<_>>());
    eprintln!("this goes to stderr");
    std::fs::write("/tmp/x.txt", "fs works").unwrap();
    println!("{}", std::fs::read_to_string("/tmp/x.txt").unwrap());
}
