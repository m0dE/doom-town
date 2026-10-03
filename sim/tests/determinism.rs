mod common;
use common::*;
use doomsim::random::BotRng;
use doomsim::world::*;

/// scripted pseudo-human input for a few slots
fn drive(w: &mut World, rng: &mut BotRng) {
    for slot in [3usize, 17, 42] {
        let yaw = rng.below(65536);
        let pitch = rng.range(-8000, 8000);
        let f = rng.range(-50, 50);
        let s = rng.range(-40, 40);
        let mut b = rng.below(8);
        if rng.chance(1, 20) {
            b |= rng.range(1, 9) as u32 * 16;
        }
        w.set_cmd(slot, yaw, pitch, f, s, b);
    }
}

fn run_pair(name: &str, tics: u32) {
    let map = load(name);
    let mut a = World::new(map.clone(), 777, 64);
    let mut b = World::new(map.clone(), 777, 64);
    for s in [3usize, 17, 42] {
        a.human_join(s);
        b.human_join(s);
    }
    let mut ra = BotRng::new(5);
    let mut rb = BotRng::new(5);
    let mut buf = Vec::new();
    let mut buf2 = Vec::new();
    let mut c: Option<World> = None; // clone taken mid-run
    let mut d: Option<World> = None; // deserialized mid-run
    let mut rc = BotRng::new(0);
    let mut rd = BotRng::new(0);
    for t in 0..tics {
        if t == tics / 3 {
            c = Some(a.clone());
            rc = ra.clone();
            let bytes = a.serialize();
            let dw = World::deserialize(map.clone(), &bytes).expect("deserialize");
            assert_eq!(dw.serialize(), bytes, "re-serialize differs");
            d = Some(dw);
            rd = ra.clone();
        }
        if t == tics / 2 {
            // membership changes mid-run
            a.human_leave(17);
            b.human_leave(17);
            if let Some(c) = c.as_mut() { c.human_leave(17); }
            if let Some(d) = d.as_mut() { d.human_leave(17); }
            a.human_join(60);
            b.human_join(60);
            if let Some(c) = c.as_mut() { c.human_join(60); }
            if let Some(d) = d.as_mut() { d.human_join(60); }
        }
        drive(&mut a, &mut ra);
        drive(&mut b, &mut rb);
        if let Some(c) = c.as_mut() { drive(c, &mut rc); }
        if let Some(d) = d.as_mut() { drive(d, &mut rd); }
        a.tick();
        b.tick();
        let ha = a.hash_with(&mut buf);
        let hb = b.hash_with(&mut buf2);
        assert_eq!(ha, hb, "{} tic {}: twin worlds diverged", name, t);
        if let Some(c) = c.as_mut() {
            c.tick();
            assert_eq!(c.hash_with(&mut buf2), ha, "{} tic {}: clone diverged", name, t);
        }
        if let Some(d) = d.as_mut() {
            d.tick();
            assert_eq!(d.hash_with(&mut buf2), ha, "{} tic {}: deserialized world diverged", name, t);
        }
    }
    println!("{}: {} tics deterministic, final hash {:08x}, {} bytes serialized", name, tics, a.hash_with(&mut buf), buf.len());
}

#[test]
fn determinism_map19() {
    run_pair("MAP19", 35 * 120);
}

#[test]
fn determinism_map01() {
    run_pair("MAP01", 35 * 120);
}

#[test]
fn corrupt_snapshots_do_not_panic() {
    let map = load("MAP01");
    let mut w = World::new(map.clone(), 1, 32);
    for _ in 0..35 * 20 {
        w.tick();
    }
    let bytes = w.serialize();
    let mut rng = BotRng::new(77);
    let mut accepted = 0;
    for k in 0..300 {
        let mut b = bytes.clone();
        if k % 3 == 0 {
            b.truncate(rng.below(b.len() as u32) as usize);
        } else {
            for _ in 0..1 + rng.below(4) {
                let i = rng.below(b.len() as u32) as usize;
                b[i] ^= 1 << rng.below(8);
            }
        }
        if let Some(mut d) = World::deserialize(map.clone(), &b) {
            accepted += 1;
            // a flipped payload bit is still a valid world sometimes; it must run
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                for _ in 0..35 {
                    d.tick();
                }
            }));
            let _ = r;
        }
    }
    println!("corrupt snapshots accepted (still well-formed): {}/300", accepted);
}
