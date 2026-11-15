import asyncio
import os
import signal
from secrets import token_hex


def on_starting(server):
    from app.services.plugin_service import provision_installed_plugin_dependencies

    # The master completes the dependency pass before any worker imports app.main.
    async def provision():
        loop = asyncio.get_running_loop()
        task = asyncio.current_task()
        signals = (signal.SIGTERM, signal.SIGINT, signal.SIGQUIT)
        previous = {sig: signal.getsignal(sig) for sig in signals}
        # Gunicorn installs its own shutdown handlers after this hook.
        def cancel():
            # One cancellation lets the installer reap its process group even on repeated signals.
            if not task.cancelling():
                task.cancel()

        try:
            for sig in signals:
                loop.add_signal_handler(sig, cancel)
            await provision_installed_plugin_dependencies()
        finally:
            for sig, handler in previous.items():
                loop.remove_signal_handler(sig)
                signal.signal(sig, handler)

    try:
        asyncio.run(provision())
    except asyncio.CancelledError:
        if server.pidfile is not None:
            server.pidfile.unlink()
        raise SystemExit(0) from None

    # Workers inherit one identity for this master, including across HUP reloads.
    os.environ["FILAMAN_GUNICORN_INSTANCE"] = token_hex(16)


def post_fork(server, worker):
    from app.core.worker_reload import track_worker_listeners

    track_worker_listeners(listener.sock for listener in worker.sockets)
