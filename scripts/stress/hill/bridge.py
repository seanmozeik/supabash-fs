"""Test-only authenticated TCP transport over Modal's encrypted tunnels."""
import asyncio
import hmac
import json
from pathlib import Path
import ssl
import sys

config = json.loads(Path('/tmp/hill-config.json').read_text())
secret = config['bridgeSecret'].encode()
server = sys.argv[1] == 'server'

async def relay(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    finally:
        writer.close()

async def connection(reader, writer, destination):
    try:
        if server:
            supplied = await asyncio.wait_for(reader.readexactly(len(secret)), 5)
            if not hmac.compare_digest(supplied, secret):
                return
            if destination[1] == 3000:
                destination = (json.loads(Path('/tmp/hill-config.json').read_text())['restIp'], 3000)
            remote_reader, remote_writer = await asyncio.open_connection(*destination)
        else:
            remote_reader, remote_writer = await asyncio.open_connection(
                destination, 443, ssl=ssl.create_default_context())
            remote_writer.write(secret)
            await remote_writer.drain()
        await asyncio.gather(relay(reader, remote_writer), relay(remote_reader, writer))
    except (OSError, asyncio.IncompleteReadError, TimeoutError):
        pass
    finally:
        writer.close()

async def main():
    targets = [(54324, ('127.0.0.1', 54322)), (54325, (config['restIp'], 3000))] if server else [
        (15432, config['dbTunnel']), (15433, config['restTunnel'])]
    listeners = []
    for port, destination in targets:
        async def handler(reader, writer, destination=destination):
            await connection(reader, writer, destination)
        listeners.append(await asyncio.start_server(handler, '0.0.0.0' if server else '127.0.0.1', port))
    await asyncio.gather(*(listener.serve_forever() for listener in listeners))

asyncio.run(main())
