//! Probes each truck's interior model: its box, its locators, and how much of every face its pieces cover.
//!
//!     cargo run -p westplay-mapdata --release --example cabin_probe -- <game dir> [model…]

use std::collections::BTreeSet;
use std::path::Path;

use westplay_mapdata::buildings;
use westplay_mapdata::files::GameFiles;
use westplay_mapdata::pmg::Pmg;
use westplay_mapdata::sii;

/// How near a face a piece must reach (metres) to count as covering it.
const TOL: f32 = 0.03;
/// The grid a face is measured on.
const GRID: usize = 48;

fn main() {
    let mut args = std::env::args().skip(1);
    let game = args
        .next()
        .unwrap_or_else(|| r"D:\SteamLibrary\steamapps\common\Euro Truck Simulator 2".to_owned());
    let files = match GameFiles::install(Path::new(&game)) {
        Ok(files) => files,
        Err(error) => {
            eprintln!("{error}");
            return;
        }
    };
    let models: Vec<String> = args.collect();
    let models = if models.is_empty() {
        [
            "scania.s_2016",
            "scania.r_2016",
            "daf.2021",
            "volvo.fh_2021",
            "man.tgx_2020",
            "renault.t",
            "mercedes.actros2014",
            "iveco.sway",
        ]
        .iter()
        .map(|model| (*model).to_owned())
        .collect()
    } else {
        models
    };
    for model in models {
        match model.strip_prefix("list:") {
            Some(dir) => {
                let dirs = files.dirs(dir).unwrap_or_default();
                let names = files.list(dir).unwrap_or_default();
                println!("\n== {dir}\n   dirs {}\n   files {}", dirs.join(", "), names.join(", "));
            }
            None => probe(&files, &model),
        }
    }
}

fn probe(files: &GameFiles, model: &str) {
    let dir = ["truck", "car"]
        .iter()
        .map(|kind| format!("/def/vehicle/{kind}/{model}/interior"))
        .find(|dir| files.list(dir).is_ok_and(|list| !list.is_empty()))
        .unwrap_or_else(|| format!("/def/vehicle/truck/{model}/interior"));
    let Ok(list) = files.list(&dir) else {
        println!("\n== {model}: no interior folder");
        return;
    };
    let mut seen = BTreeSet::new();
    let mut found = false;
    for name in list.iter().filter(|name| name.ends_with(".sii")) {
        let path = format!("{dir}/{name}");
        let Ok(units) = sii::read_units(files, &path) else { continue };
        let Some(unit) = units.iter().find(|unit| !unit.class.is_empty()) else { continue };
        let Some(pmg_path) = unit.get("model") else { continue };
        if !seen.insert(pmg_path.to_owned()) {
            continue;
        }
        found = true;
        match files.read(&pmg_path.replace(".pmd", ".pmg")) {
            Ok(Some(bytes)) => report(model, name, pmg_path, &bytes),
            _ => println!("\n== {model} / {name}: {pmg_path} not read"),
        }
    }
    if !found {
        println!("\n== {model}: no interior definitions in {dir}");
    }
}

fn report(model: &str, definition: &str, pmg_path: &str, bytes: &[u8]) {
    let Some(pmg) = Pmg::read(bytes) else {
        println!("\n== {model} / {definition}: {pmg_path} is not a model");
        return;
    };
    let Some((lo, hi)) = pmg.model_box() else {
        println!("\n== {model} / {definition}: {pmg_path}'s box doesn't read");
        return;
    };
    let count = pmg.piece_count().unwrap_or(0);
    let pieces: Vec<([f32; 3], [f32; 3])> =
        (0..count).filter_map(|i| pmg.piece(i).map(|piece| (piece.min, piece.max))).collect();
    println!("\n== {model} / {definition}");
    println!("   pmg    {pmg_path}  (format 0x{:x}, {count} pieces)", pmg.version);
    println!(
        "   box    x {:.3}..{:.3}   y {:.3}..{:.3}   z {:.3}..{:.3}",
        lo[0], hi[0], lo[1], hi[1], lo[2], hi[2]
    );
    println!(
        "   size   {:.3} wide  x  {:.3} high  x  {:.3} deep",
        hi[0] - lo[0],
        hi[1] - lo[1],
        hi[2] - lo[2]
    );
    let faces = [
        (1usize, "floor", true),
        (1, "ceiling", false),
        (0, "left", true),
        (0, "right", false),
        (2, "front", true),
        (2, "back", false),
    ];
    for (axis, name, at_min) in faces {
        println!("   {name:8} {:3.0}% covered", face_cover(&pieces, axis, at_min, lo, hi) * 100.0);
    }
    if let Some(locators) = buildings::model_locators(bytes) {
        let named: Vec<String> = locators
            .iter()
            .map(|l| format!("{} @ {:.2},{:.2},{:.2}", l.name, l.position[0], l.position[1], l.position[2]))
            .collect();
        println!("   locators {}", named.join(" | "));
    }
}

/// How much of a face the pieces cover: the share of its grid they reach, within [`TOL`].
fn face_cover(pieces: &[([f32; 3], [f32; 3])], axis: usize, at_min: bool, lo: [f32; 3], hi: [f32; 3]) -> f32 {
    let (u, v) = ((axis + 1) % 3, (axis + 2) % 3);
    let mut grid = vec![false; GRID * GRID];
    let cell = |value: f32, a: usize| {
        let span = (hi[a] - lo[a]).max(1e-6);
        ((value - lo[a]) / span * GRID as f32).clamp(0.0, GRID as f32)
    };
    for (min, max) in pieces {
        let reach = if at_min { min[axis] - lo[axis] } else { hi[axis] - max[axis] };
        if reach > TOL {
            continue;
        }
        let (u0, u1) = (cell(min[u], u).floor() as usize, cell(max[u], u).ceil() as usize);
        let (v0, v1) = (cell(min[v], v).floor() as usize, cell(max[v], v).ceil() as usize);
        for a in u0..u1.min(GRID) {
            for b in v0..v1.min(GRID) {
                grid[a * GRID + b] = true;
            }
        }
    }
    grid.iter().filter(|taken| **taken).count() as f32 / (GRID * GRID) as f32
}
