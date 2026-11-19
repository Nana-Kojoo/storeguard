"""Production server using waitress (works on Windows and Linux)."""
import os

from waitress import serve

from wsgi import app

if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    app.logger.info("StoreGuard listening on http://%s:%s", host, port)
    serve(app, host=host, port=port, threads=int(os.getenv("THREADS", "8")))
