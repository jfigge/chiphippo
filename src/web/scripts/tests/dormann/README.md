# Klaus Dormann's 6502/65C02 functional tests

`w65c02-dormann.test.js` runs these two images on the W65C02 core.

| File                              | Upstream source                                                                      | Passes at |
| --------------------------------- | ------------------------------------------------------------------------------------ | --------- |
| `6502_functional_test.bin`        | `6502_functional_test.a65` (decimal mode ON)                                         | `$3469`   |
| `65C02_extended_opcodes_test.bin` | `65C02_extended_opcodes_test.a65c` (`wdc_op = 1`, `rkwl_wdc_op = 1`, `skip_nop = 0`) | `$24F1`   |

- **Source:** <https://github.com/Klaus2m5/6502_65C02_functional_tests>, `bin_files/`,
  commit `7954e2dbb49c469ea286070bf46cdd71aeb29e4b`. The files are copied byte for byte
  and have not been reassembled.
- **Copyright:** Klaus Dormann. Licensed under the GNU General Public License,
  version 3. Chip Hippo's own `LICENSE` holds the same terms.
- **Not in the app:** the files ship only with the source tree. The packaged app leaves
  `web/scripts/tests/**` out.

Each image is a full 64 KiB memory, loaded at `$0000`, and the program starts at
`$0400`. With `ROM_vectors = 1` the image's own reset vector points at a trap, so the
test points `$FFFC` at `$0400` instead.

The program ends in a `JMP *` or `Bxx *` trap: the success address on a pass, any other
address on a failure. When an image fails, look up the trap address in the upstream
`.lst` listing. The current test number is in `test_case`, which is `$0200` in the
6502 image and `$0202` in the 65C02 image.

| File                              | SHA-256                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| `6502_functional_test.bin`        | `fa12bfc761e6f9057e4cc01a665a7b800ff01ae91f598af1e39a1201d01953fd` |
| `65C02_extended_opcodes_test.bin` | `10a2a07fa240666fa610c46accebe8d42b1000feef3aae619da15a8d152869b2` |
