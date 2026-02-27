#!/usr/bin/env python3
"""
Murmur ICE JSON-RPC sidecar for quad bot.

Connects to Murmur's ICE admin API and exposes operations via a JSON
protocol on stdin/stdout. This sidecar runs as a long-lived subprocess
managed by the TypeScript ice-client.ts.

Protocol:
  Input:  {"id": "<id>", "method": "<method>", "params": {...}}
  Output: {"id": "<id>", "result": <value>}
          {"id": "<id>", "error": "<error message>"}
  Ready:  {"ready": true}   (written once on successful ICE connect)

Environment vars (inherited from quad):
  MUMBLE_HOST         — Murmur host (Docker service name or IP)
  MUMBLE_ICE_PORT     — ICE port (default: 6502)
  MUMBLE_ICE_SECRET   — ICE write secret (ICESECRETWRITE value)

Required Python package: zeroc-ice (pip install zeroc-ice)
"""

import sys
import json
import os
import traceback
from pathlib import Path

import Ice

# Load the Murmur slice at import time — Ice.loadSlice() compiles MumbleServer.ice
# via slice2py (bundled with zeroc-ice) and registers the module globally.
_SCRIPT_DIR = Path(__file__).parent
Ice.loadSlice(str(_SCRIPT_DIR / 'MumbleServer.ice'))
import Murmur  # noqa: E402 — must come after loadSlice


def create_communicator(host: str, port: int, secret: str) -> Ice.Communicator:
    """Create an ICE communicator with the write secret in the implicit context."""
    props = Ice.createProperties(sys.argv)
    # Reduce logging noise
    props.setProperty('Ice.Warn.Connections', '0')
    props.setProperty('Ice.ACM.Client', '0')

    init_data = Ice.InitializationData()
    init_data.properties = props
    communicator = Ice.initialize(init_data)

    if secret:
        communicator.getImplicitContext().put('secret', secret)

    return communicator


def dispatch(server: Murmur.ServerPrx, method: str, params: dict) -> object:
    """Route a JSON-RPC method call to the corresponding Murmur ICE operation."""

    if method == 'registerUser':
        info = {
            Murmur.UserInfo.UserName: params['username'],
            Murmur.UserInfo.UserPassword: params['password'],
        }
        user_id = server.registerUser(info)
        return user_id  # integer

    elif method == 'unregisterUser':
        server.unregisterUser(int(params['userId']))
        return None

    elif method == 'updateRegistration':
        updates = params.get('updates', {})
        info = {}
        if 'username' in updates:
            info[Murmur.UserInfo.UserName] = updates['username']
        if 'password' in updates:
            info[Murmur.UserInfo.UserPassword] = updates['password']
        server.updateRegistration(int(params['userId']), info)
        return None

    elif method == 'getRegisteredUsers':
        result = server.getRegisteredUsers(params.get('filter', ''))
        # Keys are integer Murmur user IDs — JSON requires string keys
        return {str(k): v for k, v in result.items()}

    elif method == 'setACL':
        acls = []
        for a in params.get('acls', []):
            acl = Murmur.ACL()
            acl.applyHere = bool(a.get('applyHere', True))
            acl.applySubs = bool(a.get('applySubs', True))
            acl.inherited = bool(a.get('inherited', False))
            acl.userid = int(a.get('userid', -1))
            acl.group = str(a.get('group', ''))
            acl.allow = int(a.get('allow', 0))
            acl.deny = int(a.get('deny', 0))
            acls.append(acl)
        server.setACL(
            int(params['channelId']),
            acls,
            [],  # no group definitions
            bool(params.get('inherit', True)),
        )
        return None

    elif method == 'getACL':
        acls, groups, inherit = server.getACL(int(params['channelId']))
        return {
            'acls': [
                {
                    'applyHere': a.applyHere,
                    'applySubs': a.applySubs,
                    'inherited': a.inherited,
                    'userid': a.userid,
                    'group': a.group,
                    'allow': a.allow,
                    'deny': a.deny,
                }
                for a in acls
            ],
            'inherit': inherit,
        }

    elif method == 'getRegistration':
        result = server.getRegistration(int(params['userId']))
        # Map UserInfo enum keys to readable string keys
        name_map = {
            0: 'UserName',
            1: 'UserEmail',
            2: 'UserComment',
            3: 'UserHash',
            4: 'UserPassword',
            5: 'UserLastActive',
            6: 'UserKDFIterations',
        }
        return {name_map.get(int(k), str(k)): v for k, v in result.items()}

    else:
        raise ValueError(f'Unknown method: {method}')


def main() -> None:
    host = os.environ.get('MUMBLE_HOST', 'mumble')
    port = int(os.environ.get('MUMBLE_ICE_PORT', '6502'))
    secret = os.environ.get('MUMBLE_ICE_SECRET', '')

    communicator = None
    try:
        communicator = create_communicator(host, port, secret)

        base = communicator.stringToProxy(f'Meta:tcp -h {host} -p {port}')
        meta = Murmur.MetaPrx.checkedCast(base)
        if not meta:
            raise RuntimeError('Cannot cast ICE proxy to Murmur.Meta — wrong host/port?')

        server = meta.getServer(1)
        if not server:
            raise RuntimeError('getServer(1) returned null — is virtual server 1 running?')

        # Signal to the TypeScript parent that ICE is connected and ready
        print(json.dumps({'ready': True}), flush=True)

        # Main command loop — read JSON lines from stdin
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue

            req_id = ''
            try:
                req = json.loads(line)
                req_id = req.get('id', '')
                method = req.get('method', '')
                params = req.get('params', {})

                result = dispatch(server, method, params)
                print(json.dumps({'id': req_id, 'result': result}), flush=True)

            except (Murmur.InvalidUserException, Murmur.InvalidChannelException) as e:
                print(json.dumps({'id': req_id, 'error': f'Murmur: {type(e).__name__}'}), flush=True)
            except Murmur.InvalidSecretException:
                print(json.dumps({'id': req_id, 'error': 'Murmur: InvalidSecret — check MUMBLE_ICE_SECRET'}), flush=True)
            except Exception as e:
                print(json.dumps({'id': req_id, 'error': str(e)}), flush=True)

    except Exception as e:
        # Fatal startup error — print to stderr so TypeScript sees it, then exit
        print(f'[mumble-ice] Fatal: {e}', file=sys.stderr, flush=True)
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
    finally:
        if communicator:
            communicator.destroy()


if __name__ == '__main__':
    main()
