import os
from secrets import token_hex


def on_starting(server):
    # Workers inherit one identity for this master, including across HUP reloads.
    os.environ["FILAMAN_GUNICORN_INSTANCE"] = token_hex(16)


def post_fork(server, worker):
    from app.core.worker_reload import track_worker_listeners

    track_worker_listeners(listener.sock for listener in worker.sockets)
