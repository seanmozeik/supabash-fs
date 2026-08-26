set dotenv-load := false
set shell := ["bash", "-euo", "pipefail", "-c"]

root := justfile_directory()
expected-bun-version := "1.4.0"
expected-deno-major := "2"

[group('help')]
[doc('List recipes')]
default:
  @just --list --unsorted

[private]
toolchain:
  @command -v bun >/dev/null || { echo "Bun is required. Install version {{expected-bun-version}}." >&2; exit 1; }
  @test "$(bun --version)" = "{{expected-bun-version}}" || { echo "Bun {{expected-bun-version}} is required." >&2; exit 1; }

[private]
deno-toolchain:
  @command -v deno >/dev/null || { echo "Deno is required." >&2; exit 1; }
  @test "$(deno --version | head -1 | cut -d' ' -f2 | cut -d'.' -f1)" = "{{expected-deno-major}}" || { echo "Deno {{expected-deno-major}} is required." >&2; exit 1; }

[group('install')]
[doc('Install the pinned dependencies')]
install:
  bun install --frozen-lockfile

[group('check')]
[doc('Check formatting, lint rules, types, and source size')]
check: toolchain
  bun run check

[group('check')]
[doc('Apply safe formatting and lint fixes')]
fix: toolchain
  bun run fix

[group('test')]
[doc('Run the test suite')]
test *args: toolchain
  bun run test {{args}}

[group('build')]
[doc('Build JavaScript and declaration outputs')]
build: toolchain
  bun run build

[group('check')]
[doc('Run checks, tests, Deno validation, build, audit, and package inspection')]
verify: check deno-toolchain
  bun run test
  bun run build
  bun run check:deno
  bun run build:smoke
  bun run audit:production
  bun run package:check
  bun run package:consumer
