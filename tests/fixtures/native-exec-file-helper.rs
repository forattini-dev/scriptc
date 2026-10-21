// Harmless subprocess oracle shared by Node and native compiler tests.
use std::io::Write;
fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("ok") => { println!("stdout-value"); eprintln!("stderr-value"); }
        Some("fail") => { println!("partial"); eprintln!("diagnostic"); std::process::exit(7); }
        Some("slow") => { std::thread::sleep(std::time::Duration::from_secs(2)); println!("finished"); }
        Some("large") => { std::io::stdout().write_all(&[b'a'; 64]).unwrap(); }
        Some("env") => println!("{}", std::env::var("SCRIPTC_EXEC_TEST_VALUE").unwrap_or_default()),
        Some("cwd") => println!("{}", std::env::current_dir().unwrap().display()),
        _ => std::process::exit(2),
    }
}
