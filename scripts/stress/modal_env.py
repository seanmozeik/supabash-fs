"""Control one disposable Docker-capable Modal VM; never use production secrets."""

import argparse
import hashlib
import json
from pathlib import Path
import tarfile

import modal

ROOT = Path(__file__).resolve().parents[2]
STATE = Path("/tmp/supabash-modal-070")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["up", "exec", "pull", "down", "upload"])
    parser.add_argument("args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    STATE.mkdir(exist_ok=True)
    state_file = STATE / "sandbox.json"
    if args.action == "up":
        if state_file.exists():
            raise RuntimeError("Existing sandbox record; use it or terminate it first.")
        image = (
            modal.Image.from_registry("oven/bun:1.4.0")
            .apt_install("docker.io", "curl", "ca-certificates", "python3", "postgresql-client")
            .run_commands(
                "curl -fsSL https://github.com/supabase/cli/releases/download/v2.111.0/supabase_linux_amd64.tar.gz | tar -xz -C /usr/local/bin supabase"
            )
        )
        with modal.enable_output():
            sandbox = modal.Sandbox.create(
                "/usr/sbin/dockerd",
                app=modal.App.lookup("supabash-070-stress", create_if_missing=True),
                image=image,
                cpu=(8, 8),
                memory=32768,
                timeout=7200,
                experimental_options={"vm_runtime": True},
            )
        state_file.write_text(json.dumps({"id": sandbox.object_id, "cpu": 8, "memoryMiB": 32768}))
        print(state_file.read_text(), flush=True)
        return
    sandbox = modal.Sandbox.from_id(json.loads(state_file.read_text())["id"])
    if args.action == "upload":
        archive = STATE / "source.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            for name in ["src", "tests", "sql", "scripts", "dist", "package.json", "bun.lock", "deno.check.json", "deno.lock", "tsconfig.json"]:
                path = ROOT / name
                if path.exists():
                    tar.add(path, arcname=name)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        (STATE / "source-sha256.txt").write_text(digest + "\n")
        sandbox.filesystem.copy_from_local(str(archive), "/tmp/source.tar.gz")
        print(f"Uploaded candidate archive SHA256 {digest}")
    elif args.action == "exec":
        process = sandbox.exec(*args.args, timeout=3600)
        for line in process.stdout:
            print(line, end="", flush=True)
        print(process.stderr.read(), end="", flush=True)
        process.wait()
        raise SystemExit(process.returncode)
    elif args.action == "pull":
        remote, local = args.args
        sandbox.filesystem.copy_to_local(remote, local)
        print(f"Saved {local}")
    else:
        sandbox.terminate(wait=True)
        state_file.rename(STATE / "terminated-sandbox.json")
        print("Sandbox terminated.")


if __name__ == "__main__":
    main()
