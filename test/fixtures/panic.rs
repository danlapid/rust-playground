fn main() {
    let caught = std::panic::catch_unwind(|| panic!("caught one"));
    println!("caught={}", caught.is_err());
    let v: Vec<i32> = Vec::new();
    println!("about to index out of bounds");
    println!("{}", v[3]);
}
