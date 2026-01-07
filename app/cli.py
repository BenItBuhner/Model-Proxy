"""
CLI interface for model-proxy.

Provides command-line interface for running the model proxy server.
"""

import os
import sys

# Add the project root to the path so we can import app modules
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, project_root)

# Load environment variables from .env file FIRST, before any other imports
from dotenv import load_dotenv

load_dotenv()

import uvicorn
import typer
from typing import Optional

# Create Typer app
app = typer.Typer(
    name="model-proxy",
    help="A production-ready FastAPI application that provides a unified, multi-provider LLM inference proxy",
    rich_markup_mode="rich",
)


@app.command()
def run(
    host: Optional[str] = typer.Option(
        "0.0.0.0", "--host", help="Host to bind the server to"
    ),
    port: Optional[int] = typer.Option(
        8000, "--port", help="Port to bind the server to"
    ),
    reload: Optional[bool] = typer.Option(
        False, "--reload", help="Enable auto-reload for development"
    ),
    workers: Optional[int] = typer.Option(
        1, "--workers", help="Number of worker processes (only used when reload=False)"
    ),
    log_level: Optional[str] = typer.Option(
        "info", "--log-level", help="Log level for the server"
    ),
):
    """
    Start the model-proxy server.

    This command starts the FastAPI server with the specified options.
    By default, it listens on 0.0.0.0:8000.
    """
    typer.echo(f"Starting model-proxy server on {host}:{port}")

    if reload:
        typer.echo("🔄 Auto-reload enabled")
        # Use uvicorn's reload mode
        uvicorn.run(
            "app.main:app", host=host, port=port, reload=True, log_level=log_level
        )
    else:
        typer.echo(f"🚀 Starting with {workers} worker(s)")
        # Use multiple workers for production
        uvicorn.run(
            "app.main:app", host=host, port=port, workers=workers, log_level=log_level
        )


@app.command()
def version():
    """Show the version of model-proxy."""
    typer.echo("model-proxy version 0.1.0")


def main():
    """Main entry point for the CLI."""
    app()


if __name__ == "__main__":
    main()
