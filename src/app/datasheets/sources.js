/*
 * Copyright 2026 Jason Figge
 *
 * This file is part of Chip Hippo.
 *
 * Chip Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * Chip Hippo is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with Chip Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

// sources.js — the hard-coded catalog-part → datasheet-PDF table behind
// Settings ▸ Data Sheets ▸ Download.
//
// ONE BLOCK PER LIBRARY, and that is the whole extensibility story: a part
// whose datasheet lives on a different host is a line in a new (or existing)
// library block, never a special case in the downloader. Each block owns its
// own `base`, and a part's path is RELATIVE to it — so a base is stated once,
// the table stays one readable line per part, and the "may main fetch this?"
// question has a per-entry answer rather than a global one.
//
// WHY A TABLE AND NOT A SEARCH: nothing here is derived. A part id is not a
// file name anywhere in the world — USC's library holds the '86 as
// `sn74ls86a.pdf`, the '74 as `DM74LS74A.pdf`, and the '139 inside the '138's
// file; WDC ships the '02 as `W65C02s.pdf` — so the mapping is stated once, by
// hand, and proved by app/tests/datasheet-sources.test.js (every key is a real
// catalog id, every path stays inside its own library). Deriving it would mean
// guessing at a vendor's file naming, and a guess that misses is a silent 404.
//
// WHY IN MAIN: this is the list of URLs main is willing to fetch. Keeping it
// here means the renderer asks for "the datasheets" and never for a URL, so
// the download button cannot become a way to make the app fetch something
// arbitrary — the same reason main owns which PATHS may be touched.
//
// THE TABLE IS DELIBERATELY PARTIAL. It covers what these libraries actually
// publish; a catalog part with no entry is simply not downloaded (the download
// reports its own total, and the pin-assignments window shows a datasheet
// button only for a part whose PDF is on disk). One chip has no source here
// today: the '573. TI's is ALS, HC and F — a different family with the same
// pinout, close enough to mislead, so deliberately not offered as the LS part
// — and nobody who still publishes carries the LS one. NOR DOES ANY DISCRETE
// beyond the four listed below: a generic LED, resistor, slide switch, DIP
// switch, PSU or clock brick has no manufacturer part number to aim a URL at,
// so there is nothing to hand-verify.
//
// "No source" means NOBODY PUBLISHES IT, never that nobody looked — the '533
// and the AM27C1024 sat in that list until an out-of-family source turned up
// for each (Rochester's re-creation of the original Fairchild sheet, and
// Atmel's pin-identical AT27C1024; both argued at their entries below).
//
// A HOST HAS TO ANSWER A PROGRAM, not just a browser. Distributor mirrors
// (Mouser) and some vendor front-ends (Microchip's `/content/dam/` path,
// Alliance's product pages) sit behind bot protection and hand back a 403 or
// an HTML challenge with status 200 — which the `%PDF` check turns into an
// honest failure rather than a corrupt file, but a failure all the same. So
// a source is chosen for a host that serves the bytes, not for whichever URL
// the site happens to link.
"use strict";

/**
 * Every published library a datasheet may come from.
 *
 * `base` MUST end in a slash — a path is resolved against it with `new URL`,
 * which would otherwise drop the last segment. `name` is what the user is
 * told the files came from, so it is the library's own name, not a hostname.
 */
const LIBRARIES = Object.freeze([
  {
    id: "usc",
    name: "USC EE 459Lx reference library",
    base: "https://ece-classes.usc.edu/ee459/library/",
    // Vendor scans of the 74LS family (Fairchild / TI / Motorola), collected
    // for a university course. Two ids may share a source file — a single
    // vendor datasheet routinely covers a pair of parts ('138/'139,
    // '174/'175) — and each still gets its own copy, so a part is never one
    // indirection away from the sheet that documents it.
    parts: {
      // ── Gates ──────────────────────────────────────────────────────────
      "74LS00": "datasheets/DM74LS00.pdf",
      "74LS02": "datasheets/DM74LS02.pdf",
      "74LS04": "datasheets/DM74LS04.pdf",
      "74LS08": "datasheets/DM74LS08.pdf",
      "74LS10": "datasheets/DM74LS10.pdf",
      "74LS11": "datasheets/DM74LS11.pdf",
      "74LS14": "datasheets/DM74LS14.pdf",
      "74LS20": "datasheets/DM74LS20.pdf",
      "74LS27": "datasheets/DM74LS27.pdf",
      "74LS30": "datasheets/DM74LS30.pdf",
      "74LS32": "datasheets/DM74LS32.pdf",
      "74LS86": "datasheets/sn74ls86a.pdf",
      "74LS125": "datasheets/DM74LS125A.pdf",

      // ── Flip-flops, latches & registers ────────────────────────────────
      "74LS74": "datasheets/DM74LS74A.pdf",
      "74LS76": "datasheets/sn74ls76a.pdf",
      "74LS112": "datasheets/DM74LS112A.pdf",
      "74LS173": "datasheets/74LS173.pdf",
      "74LS174": "datasheets/DM74LS174.pdf",
      "74LS175": "datasheets/DM74LS174.pdf", // '174's sheet documents both
      "74LS273": "datasheets/DM74LS273.pdf",

      // ── Counters & shift registers ─────────────────────────────────────
      "74LS161": "datasheets/DM74LS161A.pdf",
      "74LS165": "datasheets/DM74LS165.pdf",
      "74LS169": "datasheets/DM74LS169A.pdf",
      "74LS193": "datasheets/DM74LS193.pdf",

      // ── Decoders, multiplexers & buffers ───────────────────────────────
      "74LS138": "datasheets/DM74LS138.pdf",
      "74LS139": "datasheets/DM74LS138.pdf", // '138's sheet documents both
      "74LS151": "datasheets/DM74LS151.pdf",
      "74LS157": "datasheets/DM74LS157.pdf",
      "74LS240": "datasheets/DM74LS240.pdf",
      "74LS244": "datasheets/DM74LS244.pdf",
      "74LS245": "datasheets/DM74LS245.pdf",

      // ── Arithmetic & comparison ────────────────────────────────────────
      "74LS85": "datasheets/DM74LS85.pdf",
      "74LS148": "datasheets/SN74LS147-D.PDF", // the '147/'148 encoder sheet
      "74LS181": "datasheets/DM74LS181.pdf",
      "74LS283": "datasheets/DM74LS283.pdf",

      // ── Memory ─────────────────────────────────────────────────────────
      HM62256: "datasheets/hm62256.pdf",
      // The catalog's generic 8K×8 SRAM IS the 6264 — same DIP-28 pinout,
      // same organisation — so the industry part's sheet documents it.
      "ram-8k": "datasheets/6264.pdf",

      // ── Discretes & modules ────────────────────────────────────────────
      // Not chips, but the pinout window's datasheet button is keyed on the
      // part id whatever the part is, so these cost nothing extra and answer
      // the questions ("which pin is RS?", "what is pin 1 of the array?") a
      // pin map alone does not.
      rnet9: "datasheets/Resistors.pdf",
      "osc-full": "datasheets/Oscillator.pdf",
      "osc-half": "datasheets/Oscillator.pdf",
    },
  },
  {
    id: "ti",
    name: "Texas Instruments",
    base: "https://www.ti.com/lit/ds/symlink/",
    // The parts USC's collection does not carry, from the vendor that still
    // publishes them. TI's file name is the DEVICE it was written around, not
    // the part you looked up: a revision suffix is part of the name ('73A,
    // '107A, '257B, '259B, '279A are the only versions TI documents), and the
    // '01 sheet is filed under its 54-series sibling. So each line below is a
    // fact about TI's library, not a pattern — which is exactly why this
    // table is hand-written.
    parts: {
      "74LS01": "sn54ls01.pdf", // one sheet covers SN54LS01 + SN74LS01
      "74LS03": "sn74ls03.pdf",
      "74LS05": "sn74ls05.pdf",
      "74LS47": "sn74ls47.pdf",
      "74LS73": "sn74ls73a.pdf",
      "74LS75": "sn74ls75.pdf",
      "74LS90": "sn74ls90.pdf",
      "74LS107": "sn74ls107a.pdf",
      "74LS153": "sn74ls153.pdf",
      "74LS164": "sn74ls164.pdf",
      "74LS257": "sn74ls257b.pdf",
      "74LS259": "sn74ls259b.pdf",
      "74LS279": "sn74ls279a.pdf",
      "74LS595": "sn74ls595.pdf",
      // ── The CD4000B CMOS family (Feature 400) ───────────────────────────
      // Mostly Harris originals TI scanned, so the diagrams are images and a
      // sheet routinely documents a family of parts: each part below names
      // the sheet that carries ITS diagram. Verified by rendering each sheet
      // and reading the part number and the 14/16-lead plastic DIP (the "E"
      // suffix) off it. A shared sheet is fetched once and saved under every
      // part that names it (download.js).
      CD4001B: "cd4001b.pdf", // SCHS015C: CD4001B, CD4002B, CD4025B
      CD4002B: "cd4001b.pdf",
      CD4025B: "cd4001b.pdf",
      CD4078B: "cd4078b.pdf", // SCHS059C
      CD4011B: "cd4011b.pdf", // SCHS021D: CD4011B, CD4012B, CD4023B
      CD4012B: "cd4011b.pdf",
      CD4023B: "cd4011b.pdf",
      CD4068B: "cd4068b.pdf", // SCHS053C
      CD4093B: "cd4093b.pdf", // SCHS115D
      CD4073B: "cd4073b.pdf", // SCHS057C: CD4073B, CD4081B, CD4082B
      CD4081B: "cd4073b.pdf",
      CD4082B: "cd4073b.pdf",
      CD4071B: "cd4071b.pdf", // SCHS056D: CD4071B, CD4072B, CD4075B
      CD4072B: "cd4071b.pdf",
      CD4075B: "cd4071b.pdf",
      CD4030B: "cd4030b.pdf", // SCHS035C
      CD4070B: "cd4070b.pdf", // SCHS055E: CD4070B, CD4077B
      CD4077B: "cd4070b.pdf",
      CD4069UB: "cd4069ub.pdf", // SCHS054E
      CD40106B: "cd40106b.pdf", // SCHS097F
      // SCHS046L: CD4049UB, CD4050B. Its CD4050B pin table copies the
      // 4049's "Inverting output" wording; the function table is right.
      CD4049UB: "cd4049ub.pdf",
      CD4050B: "cd4049ub.pdf",
      CD4007UB: "cd4007ub.pdf", // SCHS018C
      CD4013B: "cd4013b.pdf", // SCHS023E
      CD4027B: "cd4027b.pdf", // SCHS032D
      CD4017B: "cd4017b.pdf", // SCHS027C: CD4017B, CD4022B
      CD4022B: "cd4017b.pdf",
      CD4040B: "cd4040b.pdf", // SCHS030D: CD4020B, CD4024B, CD4040B
      CD4020B: "cd4040b.pdf",
      CD4024B: "cd4040b.pdf",
      CD4029B: "cd4029b.pdf", // SCHS034C
      CD4510B: "cd4510b.pdf", // SCHS071B: CD4510B, CD4516B
      CD4516B: "cd4510b.pdf",
      CD4094B: "cd4094b.pdf", // SCHS063B
      CD4028B: "cd4028b.pdf", // SCHS033C
      CD4511B: "cd4511b.pdf", // SCHS072B
      CD4066B: "cd4066b.pdf", // SCHS051J
      CD4051B: "cd4051b.pdf", // SCHS047O: CD4051B, CD4052B, CD4053B
      CD4052B: "cd4051b.pdf",
      CD4053B: "cd4051b.pdf",
      // ── The RC-timed parts ───────────────────────────────────────────────
      CD4047B: "cd4047b.pdf", // SCHS044C
      CD4060B: "cd4060b.pdf", // SCHS049C
      CD4098B: "cd4098b.pdf", // SCHS065C
      // SCHS093C is TI's CD14538B, "Replaces CD4538B Type": TI publishes no
      // CD4538B sheet of its own, and this one states the pin-compatibility,
      // carries the CD4538B's Table I and gives its period (T = Rx·Cx).
      CD4538B: "cd14538b.pdf",
      CD4541B: "cd4541b.pdf", // SCHS085E
      // SLFS022K (NA555/NE555/SA555/SE555): a current sheet with a text layer.
      NE555: "ne555.pdf",
      // ── The bench parts (features/chiphippo-bench-parts-feature-request.md)
      // Each verified by extracting page 1.
      LM358: "lm358.pdf", // SLOS068AB: LM158…LM358B, LM2904
      ULN2003A: "uln2003a.pdf", // SLRS027T: ULN2002A/2003A/2004A
      LM317: "lm317.pdf", // SLVS044Z, "LM317 3-Pin Adjustable Regulator"
      // "LM340, LM340A and LM7805 Family Wide VIN 1.5-A Fixed Voltage
      // Regulators": the LM7805, LM7812 and LM7815. TI makes no LM7809, and
      // no vendor host found serves one to a program (ST's and onsemi's
      // refuse it), so that one part has no download.
      LM7805: "lm340.pdf",
      LM7812: "lm340.pdf",
      LM7815: "lm340.pdf",
    },
  },
  {
    id: "vishay",
    name: "Vishay",
    base: "https://www.vishay.com/docs/",
    parts: {
      // Verified by extracting page 1: "4N35, 4N36, 4N37 Optocoupler,
      // Phototransistor Output, with Base Connection" (doc. 81181), its
      // DIP-6 A 1 · C 2 · NC 3 · E 4 · C 5 · B 6.
      "4N35": "81181/4n35.pdf",
    },
  },
  {
    id: "sharp",
    name: "Sharp",
    base: "https://global.sharp/products/device/lineup/data/pdf/datasheet/",
    parts: {
      // Verified by extracting page 1: "PC817XxNSZ1B Series, DIP 4pin
      // Photocoupler", "recognized by UL1577 … as model No. PC817".
      PC817: "PC817XxNSZ1B_e.pdf",
    },
  },
  {
    id: "microchip",
    name: "Microchip (Atmel)",
    base: "https://ww1.microchip.com/downloads/en/DeviceDoc/",
    // `ww1.microchip.com` and NOT the `www.microchip.com/content/dam/…` path
    // the site links: that host answers a programmatic client with 403 (it
    // only serves a browser), and ww1 carries the same `docNNNN` files.
    //
    // Those numbers carry NO relation to the part, and several exist per
    // part: doc0006 is the '256, doc0258 is the '16-**T** (TSOP attribute
    // memory, no DIP package at all), doc0540 is the mainline '16 with the
    // 24-lead PDIP this catalog's part actually is. A revision letter is part
    // of the file name too (`doc0001h`). So the only way to know what one of
    // these is is to open it — the strongest argument in this file for a
    // hand-written, VERIFIED table over any pattern.
    parts: {
      "28C16": "doc0540.pdf", // AT28C16 — 2K × 8 EEPROM, 24-lead PDIP
      // AT28C256 — "256K (32K x 8) Paged Parallel EEPROM", the part Ben Eater's
      // 6502 boots from. Verified by extracting page 2: its 28-lead
      // Cerdip/PDIP view matches this catalog def PIN FOR PIN — A14 1, A12 2,
      // A7-A0 3-10, I/O0-I/O2 11-13, GND 14, I/O3-I/O7 15-19, CE 20, A10 21,
      // OE 22, A11 23, A9 24, A8 25, A13 26, WE 27, VCC 28. Which is also the
      // 62256 SRAM's pinout exactly, as the sheet's own "accessed like a Static
      // RAM" puts it — the reason one socket takes either part.
      AT28C256: "doc0006.pdf",
      // AT28C64 — "8,192 words by 8-bit ... electrically erasable and
      // programmable read only memory", JEDEC byte-wide DIP-28. The catalog's
      // generic 8K×8 ROM is exactly this seat, and the app treats an EEPROM
      // as a ROM anyway (it cannot drive a write cycle).
      "rom-8k": "doc0001h.pdf",
      // AT27C1024 — the one entry whose MAKER is not the one the catalog id
      // names. AMD's EPROM line has no live host, and this catalog's blurb
      // already calls the part "AMD/ST 27C1024-family": it is a JEDEC seat
      // several vendors filled, not one company's design, so Atmel's sheet
      // documents this chip rather than standing in for it.
      //
      // Verified by extracting pages 1-2: "1Mb (64K x 16) One-time
      // Programmable Read-only Memory, Atmel AT27C1024", whose 40-lead PDIP
      // diagram matches this catalog def PIN FOR PIN — VPP 1, CE 2, O15-O8
      // 3-10, GND 11, O7-O0 12-19, OE 20, A0-A8 21-29, GND 30, A9-A15 31-37,
      // NC 38, PGM 39, VCC 40, including the two GND pins the blurb warns
      // about. The same check every line here gets, and the one that matters
      // most where the part number differs.
      AM27C1024: "doc0019.pdf",
    },
  },
  {
    id: "datasheet4u",
    name: "Datasheet4U archive",
    base: "https://datasheet4u.com/pdf/",
    // A NON-VENDOR HOST, and only for parts no vendor publishes any more.
    // Both blocks below are the same story: the maker's TTL line was sold on,
    // and the buyer serves an HTML product page rather than the PDF (Motorola
    // → ON Semi for the '83, Fairchild → onsemi for the '573), while TI
    // documents only the parts that replaced them — the '283, and the '573 in
    // ALS/HC/F, a different family with the same pinout.
    // An archive is less durable than a manufacturer's own file server, so a
    // failure here is expected eventually — which the download reports by
    // name rather than hiding, and which costs one part rather than the run.
    parts: {
      // Verified by RENDERING page 1 (the file is a 4-page scan with no
      // extractable text, so nothing else could confirm it): Motorola
      // SN54/74LS83A, "4-Bit Binary Full Adder With Fast Carry", with the
      // DIP-16 connection diagram showing this part's non-standard corner
      // power pins (VCC = 5, GND = 12) — the "original pinout" the catalog
      // entry is named for, as against the '283's standard corners.
      "74LS83": "375717/74LS83.pdf",
      // Verified by extracting page 1: Fairchild DM74LS573, "Octal D-Type
      // Latch with 3-STATE Outputs" (Oct 1988, rev Mar 2000 — the same
      // document lineage as the '533 in the lcsc block), 20-lead PDIP,
      // VCC = pin 20 / GND = pin 10, and "inputs and outputs on opposite
      // sides of package", which is the flow-through pinout this catalog
      // entry's blurb names and the whole difference from the '373.
      //
      // The LS part itself, deliberately: TI's `sn74ls573.pdf` is a 404 and
      // only the ALS/HC/F versions exist there. Futurlec serves a
      // byte-identical copy, Jameco 403s a program, so the archive it is.
      "74LS573": "375668/74LS573.pdf",
    },
  },
  {
    id: "lcsc",
    name: "Rochester Electronics (LCSC document library)",
    base: "https://datasheet.lcsc.com/datasheet/pdf/",
    // The '83's position again, one part along: Fairchild's TTL line went to
    // ON Semi, who no longer publish the '533, and TI never made an LS one
    // (`sn74ls533.pdf` is a 404 there — only ALS, HC and F exist, a different
    // family with the same pinout, which this file declines to offer as the
    // LS part). What DOES still exist is Rochester Electronics, who re-create
    // discontinued parts under licence and ship the ORIGINAL manufacturer's
    // datasheet with them — so this is Fairchild's own document reached
    // through its current custodian, not a third-party retype.
    //
    // WHY A DISTRIBUTOR CDN: Rochester's own site is a search front-end, and
    // LCSC's asset host serves the same file to a program (200,
    // `application/pdf`, `%PDF` magic, no bot challenge). Its hashed path is
    // opaque and carries a `?productCode=` the file is served without, so
    // like every mirror here this is a link expected to rot — reported by
    // name, costing this one part rather than the run.
    parts: {
      // Verified by extracting pages 1-3: a Rochester cover sheet for
      // DM74LS533N wrapping Fairchild DS009811 (Oct 1988, rev Mar 2000),
      // "DM74LS533 Octal Transparent Latch with 3-STATE Outputs" — the
      // 20-lead PDIP ordering entry, VCC = pin 20 / GND = pin 10, and a
      // function table whose D=H → O=L rows are the INVERTING outputs this
      // catalog entry is the '573's counterpart for.
      "74LS533": "ca9a28f3f5851a5f4e065caf6f1bc2f7.pdf",
    },
  },
  {
    id: "hgsemi",
    name: "HGSEMI (LCSC document library)",
    base: "https://wmsc.lcsc.com/wmsc/upload/file/pdf/v2/lcsc/",
    // TI, whose sheets every other CD4000 part here comes from, has no
    // CD4528B (`cd4528b.pdf` is a 404), and Fairchild's CD4528BC sheet went
    // to onsemi, whose file server answers a program with a 403. HGSEMI
    // still MAKES the part, under the CD4528B name, and its sheet's tables
    // are Fairchild's. LCSC's asset
    // host serves it to a program (200, `%PDF`, no challenge); a distributor
    // path, so like the mirrors above a link expected to rot, and reported by
    // name when it does.
    parts: {
      // Verified by extracting the text and rendering pages 2–3: HGSEMI
      // CD4528B V1.4, "Dual Monostable Multivibrator", DIP-16, the connection
      // diagram the catalog def is drawn from (VSS 8, VDD 16), its truth
      // table, and the AC table's PWout = 0.2·Rx·Cx·ln(VDD − VSS).
      CD4528B: "2304111800_HGSEMI-CD4528BE_C5310757.pdf",
    },
  },
  {
    id: "alliance",
    name: "Alliance Memory",
    base: "https://www.alliancememory.com/wp-content/uploads/",
    parts: {
      // The catalog id is the one part number here that does NOT resolve at
      // its own maker: Alliance list an AS6C1008, not an AS6C1024, and
      // /as6c1024/ falls through to their home page. The AS6C1008 IS the chip
      // the catalog describes — "128K X 8 BIT LOW POWER CMOS SRAM", 131,072
      // words, 32-pin — so this is the right sheet under the wrong name,
      // rather than a substitute part. Renaming the catalog entry would be
      // the cleaner fix, but a ref is stamped into saved documents, so that
      // is a migration and not a rename.
      AS6C1024: "AS6C1008_Mar_2023V1.2.pdf",
    },
  },
  {
    id: "adafruit",
    name: "Adafruit document library",
    base: "https://cdn-shop.adafruit.com/datasheets/",
    // The character LCDs are the catalog's only MODULES, and a module has TWO
    // datasheets: the maker's (its header, dimensions, backlight) and the
    // CONTROLLER's. The controller's is the one this app wants, and BOTH sizes
    // point at it — because the pin assignment, the bus protocol and the
    // instruction set they share are the controller's, which is exactly why
    // they are one entry twice rather than two different files.
    //
    // The maker's half of that pair is answered somewhere else and by something
    // better than a datasheet: the two defs' `characterDisplay` blocks are the
    // 1602A and 2004A modules MEASURED (80 × 36 mm and 98 × 60 mm of PCB), which
    // is what makes each draw at its true size. A generic module has no one
    // maker's drawing to be right about, and every catalog that claims otherwise
    // disagrees with the next; a ruler does not. What a datasheet BUTTON is for
    // is the question the user has while wiring — RS, R/W, E, DB0-DB7, the
    // DDRAM/CGRAM address maps — and that is the controller's document.
    //
    // Verified by extracting page 1: Hitachi "HD44780U (LCD-II), Dot Matrix
    // Liquid Crystal Display Controller/Driver", ADE-207-272(Z) Rev 0.0 — the
    // full 60-page document, not an application-note excerpt.
    //
    // WHY A DISTRIBUTOR CDN: Hitachi's LCD line went to Renesas, who no longer
    // publish this part at all, so there is no manufacturer host left to prefer
    // — the same position the '83 is in. Among the mirrors that ANSWER A
    // PROGRAM (200 with `application/pdf` and the `%PDF` magic, no bot
    // challenge), Adafruit's is chosen for its path: `/datasheets/HD44780.pdf`
    // names the document, where SparkFun's asset CDN holds the SAME FILE (same
    // 329,795 bytes, same MD5) behind an opaque hash. Both are mirrors and so
    // both are links expected to rot eventually — the run reports that by name,
    // and it costs this one part rather than the download — but a named path is
    // the one a person can check by eye, and the one likelier to survive a
    // re-upload.
    parts: {
      lcd16x2: "HD44780.pdf",
      lcd20x4: "HD44780.pdf",
    },
  },
  {
    id: "wdc",
    name: "Western Design Center",
    base: "https://www.westerndesigncenter.com/wdc/documentation/",
    // The 65xx parts, from the company that still makes them — so these are
    // the CURRENT manufacturer's documents, not a scan of an old databook.
    parts: {
      W65C02: "w65c02s.pdf", // the 'S' (static CMOS) part the catalog models
      W65C21: "w65c21.pdf",
      W65C22: "w65c22.pdf",
    },
  },
  {
    id: "zilog",
    name: "Zilog",
    base: "https://www.zilog.com/docs/z80/",
    // The Z80 family USER MANUAL rather than a data sheet — which is why the
    // file is named for a document number and not for a part. It is the right
    // document anyway: the pin descriptions, the CPU timing diagrams every
    // M-cycle in sim/z80.js is transcribed from, and the whole instruction set,
    // from the company that still publishes it. ~1.6 MB, the largest entry in
    // this table by a wide margin, so it is also the one most likely to report
    // a timeout on a slow link (download.js gives each request 45 s).
    parts: {
      Z80A: "um0080.pdf",
    },
  },
]);

/**
 * Flatten the libraries into the lookup the downloader walks:
 * `ref → { ref, url, base, library }`.
 *
 * `base` rides along on every entry so the fetch can check that the resolved
 * URL is still inside the library it was declared in — the per-entry form of
 * the guard a single global base used to give, and the thing that keeps a
 * mistyped path (or an absolute URL pasted into a `parts` block) from turning
 * this table into a fetch-anything list.
 */
function buildSources() {
  const out = {};
  for (const lib of LIBRARIES) {
    for (const [ref, relative] of Object.entries(lib.parts)) {
      out[ref] = Object.freeze({
        ref,
        url: new URL(relative, lib.base).href,
        base: lib.base,
        library: lib.id,
      });
    }
  }
  return Object.freeze(out);
}

/** Catalog part id → its datasheet source. The id is the file name the
    download writes (`<ref>.pdf`), because that is exactly what the
    pin-assignments window looks for in the datasheet folder. */
const DATASHEET_SOURCES = buildSources();

/** How many parts the table covers — the `n/TOTAL` the progress dialog shows.
    Not the sum of the blocks: a part named in two libraries is ONE download
    (the later block wins), which the parity test forbids anyway. */
function sourceCount() {
  return Object.keys(DATASHEET_SOURCES).length;
}

module.exports = { LIBRARIES, DATASHEET_SOURCES, sourceCount };
