mod common;
use common::*;
use doomsim::game::*;
use doomsim::world::*;
#[test]
#[ignore]
fn wardiag() {
    let mut w = World::new_cfg(Config::mode(MODE_WAR, 200), vec![load("MAP19")], 7);
    for s in 0..6 {
        for _ in 0..35 * 20 { w.tick(); }
        let alive = w.alive_counts();
        let with_enemy = w.players.iter().filter(|p| w.deref(p.bot.enemy).is_some()).count();
        let dead = w.players.iter().filter(|p| p.playerstate != PST_LIVE).count();
        let pathless = w.players.iter().filter(|p| p.playerstate == PST_LIVE && p.bot.path.is_empty()).count();
        let deaths: i32 = w.players.iter().map(|p| p.deaths).sum();
        let goals: Vec<i32> = (0..5).map(|i| w.players.iter().filter(|p| p.bot.goal_point == i).count() as i32).collect();
        println!("t={}s alive {:?} dead {} with_enemy {} pathless {} deaths {} goals {:?} tickets {:?} owners {:?}", (s+1)*20, alive, dead, with_enemy, pathless, deaths, goals, w.g.team_score, w.g.points.iter().map(|p| p.owner).collect::<Vec<_>>());
    }
}
