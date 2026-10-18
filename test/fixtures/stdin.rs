use std::io::BufRead;

fn main() {
    let total: i64 = std::io::stdin().lock().lines().map(|l| l.unwrap().trim().parse::<i64>().unwrap()).sum();
    println!("sum={total}");
}
