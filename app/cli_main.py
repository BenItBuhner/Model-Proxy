"""
Model-Proxy CLI - Command-line interface for the model-proxy application.
"""

import os
import sys
import time
from typing import Annotated, Optional

import httpx
import typer
from typer import Argument, Option, Typer

# Initialize main CLI app
app = Typer(
    name="model-proxy",
    help="Multi-provider LLM inference proxy with API key fallback",
    add_completion=False,
    no_args_is_help=True,
)

# Sub-apps for grouped commands
config_app = Typer(help="Configuration management")
keys_app = Typer(help="API key management")
db_app = Typer(help="Database management")
dev_app = Typer(help="Development tools")
env_app = Typer(help="Environment management")
add_app = Typer(help="Interactive configuration add")

app.add_typer(config_app, name="config")
app.add_typer(keys_app, name="keys")
app.add_typer(db_app, name="db")
app.add_typer(dev_app, name="dev")
app.add_typer(env_app, name="env")
app.add_typer(add_app, name="add")

# Version information
VERSION = "0.1.0"


def print_success(message: str):
    """Print success message in green."""
    symbol = "[OK]" if sys.platform == "win32" else "✓"
    typer.echo(typer.style(f"{symbol} {message}", fg=typer.colors.GREEN, bold=True))


def print_error(message: str):
    """Print error message in red."""
    symbol = "[ERROR]" if sys.platform == "win32" else "✗"
    typer.echo(
        typer.style(f"{symbol} {message}", fg=typer.colors.RED, bold=True), err=True
    )


def print_warning(message: str):
    """Print warning message in yellow."""
    symbol = "[WARNING]" if sys.platform == "win32" else "⚠"
    typer.echo(typer.style(f"{symbol} {message}", fg=typer.colors.YELLOW, bold=True))


def print_info(message: str):
    """Print info message in blue."""
    symbol = "[INFO]" if sys.platform == "win32" else "ℹ"
    typer.echo(typer.style(f"{symbol} {message}", fg=typer.colors.BLUE))


def ensure_env_loaded():
    """Ensure environment variables are loaded from .env file."""
    try:
        from dotenv import load_dotenv

        load_dotenv()
    except ImportError:
        # If dotenv is not available, continue without it
        pass


@app.command()
def start(
    host: Annotated[
        str, Option("--host", "-h", help="Host to bind to", show_default="127.0.0.1")
    ] = "127.0.0.1",
    port: Annotated[
        int, Option("--port", "-p", help="Port to run on", show_default=9876)
    ] = 9876,
    reload: Annotated[
        bool,
        Option(
            "--reload", help="Enable auto-reload for development", show_default=False
        ),
    ] = False,
    workers: Annotated[
        int,
        Option("--workers", "-w", help="Number of worker processes", show_default=1),
    ] = 1,
    log_level: Annotated[
        str, Option("--log-level", "-l", help="Log level", show_default="info")
    ] = "info",
    env_file: Annotated[
        Optional[str], Option("--env-file", help="Load environment from specific file")
    ] = None,
):
    """
    Start the model-proxy server.

    Example:
        model-proxy start --port 8000 --reload
    """
    ensure_env_loaded()

    if env_file:
        if os.path.exists(env_file):
            print_info(f"Loading environment from: {env_file}")
            from dotenv import load_dotenv

            load_dotenv(env_file)
        else:
            print_error(f"Environment file not found: {env_file}")
            raise typer.Exit(2)

    # Validate basic configuration before starting
    client_api_key = os.getenv("CLIENT_API_KEY")
    if (
        not client_api_key
        and os.getenv("REQUIRE_CLIENT_API_KEY", "false").lower() == "true"
    ):
        print_error(
            "CLIENT_API_KEY is required but not set. Set it in .env file or environment."
        )
        raise typer.Exit(2)

    # Warn about reload in production-like settings
    if reload and workers > 1:
        print_warning(
            "--reload is enabled with --workers > 1. Workers will be set to 1."
        )
        workers = 1

    print_success(f"Starting Model-Proxy server v{VERSION}")
    print_info(f"Address: http://{host}:{port}")
    if reload:
        print_info("Auto-reload is enabled (development mode)")

    # Import here to avoid loading FastAPI app until needed
    try:
        from app.main import app as fastapi_app
    except ImportError as e:
        print_error(f"Failed to import FastAPI app: {e}")
        raise typer.Exit(1)

    try:
        import uvicorn

        uvicorn.run(
            fastapi_app,
            host=host,
            port=port,
            reload=reload,
            workers=workers,
            log_level=log_level,
        )
    except OSError as e:
        if "Address already in use" in str(e):
            print_error(
                f"Port {port} is already in use. Try a different port with --port."
            )
            raise typer.Exit(1)
        else:
            raise


@app.command()
def health(
    endpoint: Annotated[
        str,
        Option(
            "--endpoint",
            "-e",
            help="Server endpoint URL",
            show_default="http://127.0.0.1:9876",
        ),
    ] = "http://127.0.0.1:9876",
    detailed: Annotated[
        bool, Option("--detailed", "-d", help="Show detailed component status")
    ] = False,
):
    """
    Check the health of a running server.

    Example:
        model-proxy health --endpoint http://localhost:8000
    """
    ensure_env_loaded()

    print_info(f"Checking server health at {endpoint}...")

    try:
        if detailed:
            response = httpx.get(f"{endpoint}/health/detailed", timeout=10.0)
        else:
            response = httpx.get(f"{endpoint}/health", timeout=10.0)
    except httpx.ConnectError:
        print_error("Could not connect to server. Is it running?")
        raise typer.Exit(1)
    except httpx.TimeoutException:
        print_error("Connection timed out.")
        raise typer.Exit(1)
    except httpx.ConnectTimeout:
        print_error("Connection timed out.")
        raise typer.Exit(1)
    except Exception as e:
        print_error(f"Unexpected error: {e}")
        raise typer.Exit(1)

    if response.status_code == 200:
        data = response.json()
        status = data.get("status", "unknown")

        if status == "healthy":
            print_success("Server is healthy")
            if detailed:
                print_info(f"Uptime: {data.get('uptime_seconds', 0)}s")
                print_info(f"Timestamp: {data.get('timestamp', 'N/A')}")

                # Show component status
                components = data.get("components", {})
                if components:
                    print_info("\nComponents:")
                    for comp_name, comp_data in components.items():
                        if isinstance(comp_data, dict):
                            comp_status = comp_data.get("status", "unknown")
                            status_symbol = (
                                "[OK]" if comp_status == "healthy" else "[FAIL]"
                            )
                            print(f"  {status_symbol} {comp_name}: {comp_status}")
        else:
            print_warning(f"Server status: {status}")
            if detailed and "components" in data:
                print_info("Component details:")
                for comp_name, comp_data in data["components"].items():
                    print(f"  • {comp_name}: {comp_data}")
            raise typer.Exit(1)
    elif response.status_code == 503:
        print_error("Server is unhealthy")
        if response.headers.get("content-type", "").startswith("application/json"):
            if detailed:
                data = response.json()
                if "detail" in data:
                    print_info(f"Details: {data['detail']}")
        raise typer.Exit(1)
    else:
        print_error(f"Unexpected status code: {response.status_code}")
        raise typer.Exit(1)


@app.command()
def version(
    verbose: Annotated[
        bool, Option("--verbose", "-v", help="Show detailed version information")
    ] = False,
):
    """
    Show version information.

    Example:
        model-proxy version --verbose
    """
    print_success(f"Model-Proxy version: {VERSION}")

    if verbose:
        print(f"\nPython: {sys.version.split()[0]}")
        print(f"Platform: {sys.platform}")

        try:
            import fastapi

            print(f"FastAPI: {fastapi.__version__}")
        except (ImportError, AttributeError):
            pass

        try:
            import uvicorn

            print(f"Uvicorn: {uvicorn.__version__}")
        except (ImportError, AttributeError):
            pass

        try:
            import sqlalchemy

            print(f"SQLAlchemy: {sqlalchemy.__version__}")
        except (ImportError, AttributeError):
            pass

        try:
            import pydantic

            print(f"Pydantic: {pydantic.__version__}")
        except (ImportError, AttributeError):
            pass


@config_app.command("list")
def config_list(
    format: Annotated[
        str, Option("--format", "-f", help="Output format", show_default="table")
    ] = "table",
):
    """
    List all available models.

    Example:
        model-proxy config list
        model-proxy config list --format json
    """
    ensure_env_loaded()

    try:
        from app.routing.config_loader import config_loader

        models = config_loader.get_available_models()

        if not models:
            print_warning("No models found in config/models/")
            return

        sorted_models = sorted(models)

        if format == "json":
            import json

            print(json.dumps(sorted_models, indent=2))
        elif format == "table":
            print_info(f"Found {len(sorted_models)} model(s):\n")
            for model in sorted_models:
                print(f"  • {model}")
        else:
            print_success(f"Available models: {', '.join(sorted_models)}")

    except Exception as e:
        print_error(f"Failed to list models: {e}")
        raise typer.Exit(1)


@config_app.command("validate")
def config_validate():
    """
    Validate all model configurations.

    Example:
        model-proxy config validate
    """
    ensure_env_loaded()

    print_info("Validating model configurations...")

    try:
        from app.routing.config_loader import config_loader

        models = config_loader.get_available_models()

        if not models:
            print_warning("No models found in config/models/")
            return

        valid_count = 0
        invalid_models = []

        for model in sorted(models):
            try:
                config_loader.load_config(model)
                valid_count += 1
            except Exception as e:
                invalid_models.append((model, str(e)))

        if invalid_models:
            print_error(f"Found {len(invalid_models)} invalid model(s):")
            for model, error in invalid_models:
                print(f"  [X] {model}: {error}")
            raise typer.Exit(1)
        else:
            print_success(f"All {valid_count} model(s) are valid")

    except Exception as e:
        print_error(f"Validation failed: {e}")
        raise typer.Exit(1)


@config_app.command("show")
def config_show(
    model: Annotated[str, Argument(help="Model name to show configuration for")],
):
    """
    Show configuration for a specific model.

    Example:
        model-proxy config show gpt-5.2
    """
    ensure_env_loaded()

    try:
        from app.routing.config_loader import config_loader

        config = config_loader.load_config(model)

        import json

        print(f"\nConfiguration for '{model}':\n")
        print(json.dumps(config.model_dump(), indent=2))

    except FileNotFoundError:
        print_error(f"Model not found: {model}")
        print_info("Run 'model-proxy config list' to see available models.")
        # Also print to stdout for test to find
        print(f"Model not found: {model}", file=sys.stderr)
        raise typer.Exit(1)
    except Exception as e:
        print_error(f"Failed to load configuration: {e}")
        raise typer.Exit(1)


def check_environment():
    """Check environment variables and return status."""
    issues = []

    # Check required environment variable
    client_api_key = os.getenv("CLIENT_API_KEY")
    if not client_api_key:
        issues.append(
            {
                "var": "CLIENT_API_KEY",
                "status": "missing",
                "message": "Required for client authentication",
            }
        )
    else:
        issues.append(
            {
                "var": "CLIENT_API_KEY",
                "status": "set",
                "message": "Set for client authentication",
            }
        )

    # Check optional but recommended variables
    optional_vars = {
        "KEY_COOLDOWN_SECONDS": "API key cooldown period",
        "CORS_ORIGINS": "Cross-Origin Resource Sharing configuration",
        "RATE_LIMIT_REQUESTS_PER_MINUTE": "Rate limiting configuration",
        "FAIL_ON_STARTUP_VALIDATION": "Startup validation mode",
    }

    for var, desc in optional_vars.items():
        value = os.getenv(var)
        status = "set" if value else "not set"
        issues.append({"var": var, "status": status, "message": desc})

    return issues


def check_provider_keys():
    """Check provider API keys and return status."""
    ensure_env_loaded()

    try:
        from app.core.api_key_manager import get_available_keys
        from app.core.provider_config import (
            get_all_provider_configs,
            is_provider_enabled,
        )

        provider_issues = []
        provider_configs = get_all_provider_configs()

        for provider_name in sorted(provider_configs.keys()):
            if not is_provider_enabled(provider_name):
                continue

            available_keys = get_available_keys(provider_name)
            keys_count = len(available_keys)

            if keys_count == 0:
                provider_issues.append(
                    {
                        "provider": provider_name,
                        "status": "no keys",
                        "message": "No API keys configured",
                    }
                )
            else:
                provider_issues.append(
                    {
                        "provider": provider_name,
                        "status": f"{keys_count} keys",
                        "message": f"{keys_count} API key(s) available",
                    }
                )

        return provider_issues
    except Exception as e:
        return [{"provider": "error", "status": "error", "message": str(e)}]


def check_database():
    """Check database connectivity."""
    ensure_env_loaded()

    try:
        from sqlalchemy import text

        from app.database.database import engine

        start_time = time.time()
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        response_time_ms = int((time.time() - start_time) * 1000)

        return {
            "status": "connected",
            "response_time_ms": response_time_ms,
            "message": f"Database connected ({response_time_ms}ms)",
        }
    except Exception as e:
        return {"status": "error", "message": f"Database connection failed: {e}"}


@app.command()
def doctor(
    fix: Annotated[
        bool, Option("--fix", help="Attempt to fix issues (experimental)")
    ] = False,
):
    """
    Run comprehensive system diagnostics.

    Example:
        model-proxy doctor
    """
    ensure_env_loaded()

    typer.echo(
        typer.style("Model-Proxy System Diagnostics", fg=typer.colors.CYAN, bold=True)
    )
    typer.echo()

    overall_status = True

    # Check Python version
    py_version = sys.version_info
    if py_version >= (3, 9):
        print_success(
            f"Python version: {py_version.major}.{py_version.minor}.{py_version.micro}"
        )
    else:
        print_error(
            f"Python version: {py_version.major}.{py_version.minor}.{py_version.micro} (requires 3.9+)"
        )
        overall_status = False

    # Check dependencies
    print_info("Checking dependencies...")
    required_deps = ["fastapi", "uvicorn", "sqlalchemy", "pydantic", "httpx", "typer"]
    missing_deps = []

    for dep in required_deps:
        try:
            __import__(dep)
        except ImportError:
            missing_deps.append(dep)

    if missing_deps:
        print_error(f"Missing dependencies: {', '.join(missing_deps)}")
        print_info("Run: uv pip install -e .")
        overall_status = False
    else:
        print_success("All core dependencies installed")

    # Check configuration files
    print_info("Checking configuration files...")
    config_issues = []

    required_dirs = ["config/models", "config/providers"]
    for dir_path in required_dirs:
        if not os.path.exists(dir_path):
            config_issues.append(f"Missing directory: {dir_path}")

    if config_issues:
        print_error("Configuration issues:")
        for issue in config_issues:
            print(f"  [X] {issue}")
        overall_status = False
    else:
        print_success("Configuration files structure OK")

    # Check environment variables
    print_info("Checking environment variables...")
    env_issues = check_environment()

    critical_env_issues = [e for e in env_issues if e["status"] == "missing"]
    if critical_env_issues:
        print_error("Missing critical environment variables:")
        for issue in critical_env_issues:
            print(f"  [X] {issue['var']}: {issue['message']}")
        overall_status = False
    else:
        print_success("Environment variables OK")
        typer.echo(
            f"  Set variables: {len([e for e in env_issues if e['status'] == 'set'])}"
        )

    # Check provider keys
    print_info("Checking provider API keys...")
    provider_issues = check_provider_keys()

    no_key_providers = [p for p in provider_issues if p["status"] == "no keys"]
    if no_key_providers:
        print_warning("Providers with no API keys:")
        for issue in no_key_providers:
            print(f"  [!] {issue['provider']}: {issue['message']}")
    else:
        print_success("Provider API keys configured")
        for issue in provider_issues:
            if issue["status"] != "no keys":
                print(f"  [OK] {issue['provider']}: {issue['message']}")

    # Check database
    print_info("Checking database connectivity...")
    db_status = check_database()

    if db_status["status"] == "connected":
        print_success(db_status["message"])
    else:
        print_error(db_status["message"])
        overall_status = False

    # Check model configurations
    print_info("Checking model configurations...")
    try:
        from app.routing.config_loader import config_loader

        models = config_loader.get_available_models()

        if not models:
            print_warning("No models found")
        else:
            print_success(f"Found {len(models)} model(s)")
    except Exception as e:
        print_error(f"Failed to load models: {e}")
        overall_status = False

    # Summary
    typer.echo()
    typer.echo(typer.style("=" * 50, fg=typer.colors.CYAN))

    if overall_status:
        typer.echo(
            typer.style("[OK] System looks healthy!", fg=typer.colors.GREEN, bold=True)
        )
        typer.echo("You can start the server with:")
        typer.echo(typer.style("  model-proxy start", fg=typer.colors.BLUE))
    else:
        typer.echo(
            typer.style(
                "[X] Found issues that should be addressed",
                fg=typer.colors.RED,
                bold=True,
            )
        )
        typer.echo("\nCommon fixes:")
        typer.echo("  • Install dependencies: uv pip install -e .")
        typer.echo("  • Set up .env file with required variables")
        typer.echo("  • Add provider API keys to environment")
        typer.echo()
        typer.echo("For more help, run:")
        typer.echo(typer.style("  model-proxy --help", fg=typer.colors.BLUE))

    raise typer.Exit(0 if overall_status else 1)


@env_app.command("check")
def env_check():
    """
    Check environment variable configuration.

    Example:
        model-proxy env check
    """
    ensure_env_loaded()

    print_info("Checking environment configuration...")

    issues = check_environment()

    critical_issues = [e for e in issues if e["status"] == "missing"]

    if critical_issues:
        print_error("Missing required variables:")
        for issue in critical_issues:
            print(f"  [X] {issue['var']}: {issue['message']}")
        print_info("\nSet these in your .env file or environment variables.")
        raise typer.Exit(1)
    else:
        print_success("All required environment variables are set")

        # Show optional variables
        optional_issues = [e for e in issues if e["status"] != "missing"]
        if optional_issues:
            typer.echo("\nOptional variables:")
            for issue in optional_issues:
                status_symbol = "[OK]" if issue["status"] == "set" else "[ ]"
                print(f"  {status_symbol} {issue['var']}: {issue['status']}")


@keys_app.command("list")
def keys_list():
    """
    List configured API keys (redacted for security).

    Example:
        model-proxy keys list
    """
    ensure_env_loaded()

    try:
        from app.core.api_key_manager import get_available_keys
        from app.core.provider_config import (
            get_all_provider_configs,
            is_provider_enabled,
        )

        provider_configs = get_all_provider_configs()

        if not provider_configs:
            print_warning("No providers configured")
            return

        print_info("Configured API keys (redacted):\n")

        for provider_name in sorted(provider_configs.keys()):
            if not is_provider_enabled(provider_name):
                continue

            available_keys = get_available_keys(provider_name)
            keys_count = len(available_keys)

            if keys_count == 0:
                print(f"  • {provider_name}: None configured")
            else:
                # Show masked keys
                key_preview = "**********" * (keys_count // 2)
                print(f"  • {provider_name}: {key_preview} ({keys_count} key(s))")

    except Exception as e:
        print_error(f"Failed to list API keys: {e}")
        raise typer.Exit(1)


@keys_app.command("test")
def keys_test(
    provider: Annotated[str, Argument(help="Provider name (e.g., openai, anthropic)")],
):
    """
    Test API key validity for a provider.

    Example:
        model-proxy keys test openai
    """
    ensure_env_loaded()

    print_info(f"Testing {provider} API key...")

    try:
        from app.core.api_key_manager import get_available_keys

        available_keys = get_available_keys(provider)

        if not available_keys:
            print_error(f"No API keys found for provider '{provider}'")
            print_info("Run 'model-proxy keys list' to see configured keys.")
            raise typer.Exit(1)

        print_success(f"Found {len(available_keys)} API key(s)")
        print_info(
            "Note: Actual key validity depends on provider. Check logs for API errors."
        )

        # For now, just show we found keys
        # In production, you might want to make a test API call

    except Exception as e:
        print_error(f"Failed to test API keys: {e}")
        raise typer.Exit(1)


@db_app.command("stats")
def db_stats():
    """
    Show database statistics.

    Example:
        model-proxy db stats
    """
    ensure_env_loaded()

    print_info("Gathering database statistics...")

    try:
        from sqlalchemy import func, text

        from app.database import SessionLocal
        from app.database.database import engine

        db = SessionLocal()
        try:
            # Check if tables exist
            with engine.connect() as conn:
                result = conn.execute(
                    text("SELECT name FROM sqlite_master WHERE type='table'")
                )
                tables = [row[0] for row in result.fetchall()]

            if not tables:
                print_warning("No database tables found")
                return

            print_success(f"Found {len(tables)} table(s)")

            # Get log counts if available
            from app.database.logging_models import RequestLog

            total_logs = db.query(func.count(RequestLog.id)).scalar()

            print_info("\nStatistics:")
            print(f"  • Total request logs: {total_logs}")

            # Get status breakdown
            status_counts = (
                db.query(RequestLog.status_code, func.count(RequestLog.id))
                .group_by(RequestLog.status_code)
                .all()
            )

            if status_counts:
                status_counts.sort(key=lambda x: x[0], reverse=True)
                print_info("\n  By status code:")
                for status_code, count in status_counts:
                    print(f"    • {status_code}: {count} request(s)")

        finally:
            db.close()

    except Exception as e:
        print_error(f"Failed to gather statistics: {e}")
        raise typer.Exit(1)


@db_app.command("reset")
def db_reset(
    confirm: Annotated[
        bool,
        Option("--confirm", "-y", help="Skip confirmation prompt", show_default=False),
    ] = False,
):
    """
    Reset database (development only - deletes all data).

    Example:
        model-proxy db reset --confirm
    """
    ensure_env_loaded()

    print_warning("This will delete ALL database logs and data!")
    print_warning("This action cannot be undone.")

    if not confirm:
        confirm_response = typer.confirm("Are you sure you want to reset the database?")
        if not confirm_response:
            print_info("Database reset cancelled.")
            raise typer.Exit(0)

    try:
        from app.database import logging_models, models
        from app.database.database import engine

        print_info("Resetting database...")

        # Delete all existing tables
        models.Base.metadata.drop_all(bind=engine)
        logging_models.Base.metadata.drop_all(bind=engine)

        # Recreate tables
        models.Base.metadata.create_all(bind=engine)
        logging_models.Base.metadata.create_all(bind=engine)

        print_success("Database reset successfully")
        print_info("Tables have been recreated with empty data.")

    except Exception as e:
        print_error(f"Failed to reset database: {e}")
        raise typer.Exit(1)


@dev_app.command("shell")
def dev_shell():
    """
    Open an interactive Python shell with the app loaded.

    Example:
        model-proxy dev shell
    """
    ensure_env_loaded()

    print_info("Starting interactive shell...")
    print_info("Available objects:")
    print_info("  • app - FastAPI application")
    print_info("  • db - Database session")
    print_info("  • config_loader - Model configuration loader")
    print_info("\nType 'exit()' or Ctrl+D to exit.\n")

    try:
        # Import necessary modules
        from app.database.database import SessionLocal
        from app.main import app
        from app.routing.config_loader import config_loader

        db = SessionLocal()

        # Create local namespace for the shell
        namespace = {
            "app": app,
            "db": db,
            "config_loader": config_loader,
        }

        # Start interactive shell
        import code

        code.interact(local=namespace)

    except ImportError as e:
        print_error(f"Failed to start shell: {e}")
        raise typer.Exit(1)
    finally:
        if "db" in locals():
            db.close()


@dev_app.command("test")
def dev_test(
    verbose: Annotated[
        bool, Option("--verbose", "-v", help="Show test output")
    ] = False,
):
    """
    Run the test suite.

    Example:
        model-proxy dev test
    """
    print_info("Running tests...")

    try:
        import subprocess

        cmd = ["uv", "run", "pytest"]
        if verbose:
            cmd.extend(["-v", "-s"])
        else:
            cmd.append("-q")

        result = subprocess.run(cmd)

        if result.returncode == 0:
            print_success("All tests passed!")
        else:
            print_error("Some tests failed")

        raise typer.Exit(result.returncode)

    except FileNotFoundError:
        print_error(
            "pytest not found. Install with: uv pip install pytest pytest-asyncio"
        )
        raise typer.Exit(1)


@dev_app.command("lint")
def dev_lint(
    fix: Annotated[
        bool, Option("--fix", "-f", help="Automatically fix linting issues")
    ] = False,
):
    """
    Run linter and formatter checks.

    Example:
        model-proxy dev lint --fix
    """
    print_info("Running linter (ruff)...")

    try:
        import subprocess

        # Run linter
        check_cmd = ["uv", "run", "ruff", "check", "."]
        result = subprocess.run(check_cmd)

        if result.returncode != 0:
            print_error("Linting issues found")
            if fix:
                print_info("Fixing issues...")
                fix_cmd = ["uv", "run", "ruff", "check", "--fix", "."]
                subprocess.run(fix_cmd)
            raise typer.Exit(result.returncode)

        print_success("No linting issues")

        # Run formatter check
        print_info("Running formatter (ruff format)...")
        format_cmd = ["uv", "run", "ruff", "format", "--check", "."]
        result = subprocess.run(format_cmd)

        if result.returncode != 0:
            print_warning("Formatting issues found")
            if fix:
                print_info("Fixing formatting...")
                fix_cmd = ["uv", "run", "ruff", "format", "."]
                subprocess.run(fix_cmd)
            else:
                print_info("Run 'model-proxy dev lint --fix' to fix formatting")
            raise typer.Exit(result.returncode)

        print_success("Code is properly formatted!")

    except FileNotFoundError:
        print_error("ruff not found. Install with: uv pip install ruff")
        raise typer.Exit(1)


def main():
    """Main entry point for the CLI."""
    app()


@add_app.command("provider")
def add_provider(
    list_only: Annotated[
        bool, Option("--list", "-l", help="List providers without adding new ones")
    ] = False,
    name: Annotated[
        Optional[str],
        Option("--name", "-n", help="Provider identifier (non-interactive)"),
    ] = None,
    display_name: Annotated[
        Optional[str],
        Option("--display-name", "-d", help="Provider display name (non-interactive)"),
    ] = None,
    base_url: Annotated[
        Optional[str],
        Option("--base-url", "-u", help="Provider base URL (non-interactive)"),
    ] = None,
    format_type: Annotated[
        Optional[str],
        Option(
            "--format", "-f", help="Provider format: openai, anthropic, gemini, azure"
        ),
    ] = None,
    overwrite: Annotated[
        bool, Option("--overwrite", "-o", help="Overwrite existing provider")
    ] = False,
):
    """
    Add a new LLM provider interactively or via flags.

    Supports preset formats for OpenAI, Anthropic, Gemini, and Azure.
    Use arrow keys to navigate options in interactive mode.

    Examples:
        model-proxy add provider
        model-proxy add provider --list
        model-proxy add provider --name myapi --display-name "My API" --base-url https://api.example.com --format openai
    """
    ensure_env_loaded()

    try:
        from app.cli.interactive import UserCancelled
        from app.cli.providers import (
            add_provider_interactive,
            add_provider_non_interactive,
            list_providers,
        )

        if list_only:
            list_providers()
        elif name and display_name and base_url and format_type:
            # Non-interactive mode with flags
            add_provider_non_interactive(
                name=name,
                display_name=display_name,
                base_url=base_url,
                format_type=format_type,
                overwrite=overwrite,
            )
        elif name or display_name or base_url or format_type:
            # Partial flags provided - error
            print_error(
                "Non-interactive mode requires all flags: --name, --display-name, --base-url, --format"
            )
            raise typer.Exit(1)
        else:
            print_success("Starting interactive provider configuration...")
            print_info("Use arrow keys to navigate, Ctrl+C to cancel\n")
            try:
                add_provider_interactive()
            except UserCancelled:
                print()
                print_warning("Operation cancelled by user (Ctrl+C)")
                raise typer.Exit(0)
    except KeyboardInterrupt:
        print()
        print_warning("Operation cancelled by user (Ctrl+C)")
        raise typer.Exit(0)
    except ImportError as e:
        print_error(
            f"Interactive provider module not found. Install with: pip install questionary. Error: {e}"
        )
        raise typer.Exit(1)


@add_app.command("model")
def add_model(
    list_only: Annotated[
        bool, Option("--list", "-l", help="List models without configuring new ones")
    ] = False,
    logical_name: Annotated[
        Optional[str],
        Option("--name", "-n", help="Logical model name (non-interactive)"),
    ] = None,
    provider: Annotated[
        Optional[str],
        Option("--provider", "-p", help="Provider name (non-interactive)"),
    ] = None,
    model_id: Annotated[
        Optional[str],
        Option("--model", "-m", help="Model ID from provider (non-interactive)"),
    ] = None,
    timeout: Annotated[int, Option("--timeout", "-t", help="Timeout in seconds")] = 240,
    custom: Annotated[
        bool, Option("--custom", "-c", help="Add as custom model to cache only")
    ] = False,
    overwrite: Annotated[
        bool, Option("--overwrite", "-o", help="Overwrite existing model config")
    ] = False,
):
    """
    Add model configurations interactively or via flags.

    Automatically discovers models from provider APIs.
    Supports custom models for undocumented APIs.
    Configure multi-level fallback chains.

    Examples:
        model-proxy add model
        model-proxy add model --list
        model-proxy add model --name gpt4-fallback --provider openai --model gpt-4 --timeout 120
        model-proxy add model --custom --provider openai --model gpt-4-custom
    """
    ensure_env_loaded()

    try:
        from app.cli.interactive import UserCancelled, safe_select
        from app.cli.models import (
            add_custom_model_interactive,
            add_custom_model_non_interactive,
            add_model_interactive,
            add_model_non_interactive,
            list_model_configs,
        )

        if list_only:
            list_model_configs()
        elif custom and provider and model_id:
            # Non-interactive custom model addition
            add_custom_model_non_interactive(provider=provider, model_id=model_id)
        elif logical_name and provider and model_id:
            # Non-interactive model config
            add_model_non_interactive(
                logical_name=logical_name,
                provider=provider,
                model_id=model_id,
                timeout=timeout,
                overwrite=overwrite,
            )
        elif logical_name or provider or model_id:
            # Partial flags provided
            if custom:
                print_error("Custom model requires: --provider, --model")
            else:
                print_error(
                    "Non-interactive mode requires: --name, --provider, --model"
                )
            raise typer.Exit(1)
        else:
            print_success("Starting interactive model configuration...")
            print_info("Use arrow keys to navigate, Ctrl+C to cancel\n")

            try:
                # Ask what type of configuration using safe_select for proper Ctrl+C handling
                choice = safe_select(
                    "What would you like to do?",
                    choices=[
                        "Configure model routing (select provider, then models)",
                        "Add custom model (for undocumented models)",
                        "Cancel",
                    ],
                )

                if choice == "Cancel":
                    print_info("Model configuration cancelled")
                elif choice == "Configure model routing (select provider, then models)":
                    add_model_interactive()
                elif choice == "Add custom model (for undocumented models)":
                    add_custom_model_interactive()
                else:
                    print_info("Model configuration cancelled")
            except UserCancelled:
                print()
                print_warning("Operation cancelled by user (Ctrl+C)")
                raise typer.Exit(0)
    except KeyboardInterrupt:
        print()
        print_warning("Operation cancelled by user (Ctrl+C)")
        raise typer.Exit(0)
    except ImportError as e:
        print_error(
            f"Interactive model module not found. Install with: pip install questionary. Error: {e}"
        )
        raise typer.Exit(1)


@add_app.command("key")
def add_key(
    list_only: Annotated[
        bool, Option("--list", "-l", help="List API keys without adding new ones")
    ] = False,
    provider: Annotated[
        Optional[str],
        Option("--provider", "-p", help="Provider name (non-interactive)"),
    ] = None,
    key: Annotated[
        Optional[str],
        Option("--key", "-k", help="API key value (non-interactive, use with caution)"),
    ] = None,
    env_var: Annotated[
        Optional[str],
        Option("--env-var", "-e", help="Custom environment variable name"),
    ] = None,
):
    """
    Add API keys interactively or via flags.

    Secure hidden input for key entry in interactive mode.
    Support multiple keys per provider for fallback.
    Automatic .env file management.

    Examples:
        model-proxy add key
        model-proxy add key --list
        model-proxy add key --provider openai --key sk-xxx
        model-proxy add key --provider openai --key sk-xxx --env-var OPENAI_API_KEY_2
    """
    ensure_env_loaded()

    try:
        from app.cli.api_keys import (
            add_api_key_interactive,
            add_api_key_non_interactive,
            list_api_keys,
        )
        from app.cli.interactive import UserCancelled

        if list_only:
            list_api_keys()
        elif provider and key:
            # Non-interactive mode
            add_api_key_non_interactive(provider=provider, api_key=key, env_var=env_var)
        elif provider or key:
            # Partial flags
            print_error("Non-interactive mode requires both: --provider and --key")
            raise typer.Exit(1)
        else:
            print_success("Starting interactive API key configuration...")
            print_info("Use arrow keys to navigate, Ctrl+C to cancel\n")
            try:
                add_api_key_interactive()
            except UserCancelled:
                print()
                print_warning("Operation cancelled by user (Ctrl+C)")
                raise typer.Exit(0)
    except KeyboardInterrupt:
        print()
        print_warning("Operation cancelled by user (Ctrl+C)")
        raise typer.Exit(0)
    except ImportError as e:
        print_error(
            f"Interactive API key module not found. Install with: pip install questionary. Error: {e}"
        )
        raise typer.Exit(1)
    except typer.Exit:
        raise  # Re-raise typer.Exit as-is
    except Exception as e:
        print_error(f"Failed to add API key: {e}")
        raise typer.Exit(1)


@app.command()
def setup(
    resume: Annotated[
        bool, Option("--resume", "-r", help="Resume from saved progress")
    ] = False,
    quick: Annotated[
        bool, Option("--quick", "-q", help="Quick setup (skip optional steps)")
    ] = False,
):
    """
    Run the interactive setup wizard.

    Guides you through provider setup, model configuration, and API key management.

    Examples:
        model-proxy setup
        model-proxy setup --resume
        model-proxy setup --quick
    """
    ensure_env_loaded()

    from app.cli.interactive import ask_yes_no
    from app.cli.setup_wizard import SetupWizard

    wizard = SetupWizard()

    if resume:
        wizard.setup_type = "resume"

    if quick:
        wizard.setup_type = "quick"

    try:
        wizard.run()
    except KeyboardInterrupt:
        print()
        print_warning("Setup wizard cancelled")
        if ask_yes_no("Save progress for later?", default=True):
            wizard.save_progress()
        raise typer.Exit(0)
    except Exception as e:
        print_error(f"Setup wizard failed: {e}")
        raise typer.Exit(1)


@app.command(name="help")
def help_command():
    """Show help information (alias for --help)."""
    import typer

    typer.echo("Use 'model-proxy --help' to see all commands and options.")
    typer.echo("\nQuick reference:")
    typer.echo("  model-proxy start         Start the server")
    typer.echo("  model-proxy doctor         Run diagnostics")
    typer.echo("  model-proxy setup          Run interactive setup wizard")
    typer.echo("  model-proxy config list    List available models")
    typer.echo("  model-proxy add provider   Add a new provider interactively")
    typer.echo("  model-proxy add model      Configure models interactively")
    typer.echo("  model-proxy add key        Add API keys interactively")
    typer.echo("  model-proxy --help         Show detailed help")
    raise typer.Exit(0)


if __name__ == "__main__":
    main()
