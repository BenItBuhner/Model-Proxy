"""
Tests for the Setup Wizard functionality.

Tests cover wizard utilities, status checking, progress tracking,
and the main wizard coordinator.
"""

import tempfile
from pathlib import Path
from unittest.mock import Mock


from app.cli.wizard_utils import (
    clear_progress_file,
    create_progress_bar,
    display_setup_status,
    format_step_status,
    format_model_config_summary,
    get_setup_status,
    get_step_name,
    load_progress_from_file,
    save_progress_to_file,
    should_skip_step,
    validate_prerequisites,
)


# ============================================================================
# format_step_status Tests
# ============================================================================


def test_format_step_status_completed():
    """Test status formatting for completed steps."""
    status = format_step_status("providers", True)
    assert "[✓]" in status
    assert "Providers" in status


def test_format_step_status_pending():
    """Test status formatting for pending steps."""
    status = format_step_status("models", False)
    assert "[ ]" in status
    assert "Models" in status


def test_format_step_status_api_keys():
    """Test status formatting for API keys step."""
    status = format_step_status("api_keys", True)
    assert "[✓]" in status
    assert "API Keys" in status


def test_format_step_status_unknown():
    """Test status formatting for unknown step."""
    status = format_step_status("unknown", True)
    assert "[✓]" in status
    assert "Unknown" in status


# ============================================================================
# create_progress_bar Tests
# ============================================================================


def test_progress_bar_empty_start():
    """Test progress bar at 0%."""
    bar = create_progress_bar(0, 10, width=20)
    assert "0%" in bar
    assert bar.count("█") == 0


def test_progress_bar_half_complete():
    """Test progress bar at 50%."""
    bar = create_progress_bar(5, 10, width=20)
    assert "50%" in bar
    assert bar.count("█") == 10


def test_progress_bar_complete():
    """Test progress bar at 100%."""
    bar = create_progress_bar(10, 10, width=20)
    assert "100%" in bar
    assert bar.count("█") == 20


def test_progress_bar_fractional_progress():
    """Test progress bar with fractional progress."""
    bar = create_progress_bar(1, 3, width=20)
    assert bar.count("█") >= 6  # ~33% should show 6-7 filled chars


def test_progress_bar_zero_total():
    """Test progress bar with zero total (edge case)."""
    bar = create_progress_bar(5, 0, width=20)
    assert bar == ""


def test_progress_bar_default_width():
    """Test progress bar with default width."""
    bar = create_progress_bar(1, 2)  # Should use default width of 50
    assert "%" in bar
    assert "(" in bar and ")" in bar


# ============================================================================
# get_setup_status Tests
# ============================================================================


def test_get_setup_status_empty_config():
    """Test setup status with empty configuration."""
    config_manager = Mock()
    config_manager.get_providers.return_value = {}
    config_manager.get_models.return_value = []
    config_manager.env = {}
    config_manager.config_dir = Path("/tmp/test")

    status = get_setup_status(config_manager)

    assert status["providers_count"] == 0
    assert status["models_count"] == 0
    assert status["api_keys_count"] == 0
    assert status["enabled_providers"] == 0
    assert status["providers_with_keys"] == 0
    assert status["completed_steps"] == []
    assert status["progress_percentage"] == 0
    assert len(status["recommendations"]) >= 1


def test_get_setup_status_partial_config():
    """Test setup status with partial configuration (providers only)."""
    config_manager = Mock()
    config_manager.get_providers.return_value = {
        "openai": {
            "enabled": True,
            "api_keys": {"env_var_patterns": ["OPENAI_API_KEY"]},
        },
        "anthropic": {
            "enabled": True,
            "api_keys": {"env_var_patterns": ["ANTHROPIC_API_KEY"]},
        },
    }
    config_manager.get_models.return_value = []
    config_manager.env = {}
    config_manager.config_dir = Path("/tmp/test")

    status = get_setup_status(config_manager)

    assert status["providers_count"] == 2
    assert status["models_count"] == 0
    assert status["enabled_providers"] == 2
    assert status["api_keys_count"] == 0
    assert status["providers_with_keys"] == 0
    # Only providers step is complete (~33%)
    assert status["progress_percentage"] == 33


def test_get_setup_status_complete_config():
    """Test setup status with complete configuration."""
    config_manager = Mock()
    config_manager.get_providers.return_value = {
        "openai": {
            "enabled": True,
            "api_keys": {"env_var_patterns": ["OPENAI_API_KEY"]},
        },
    }
    config_manager.get_models.return_value = [
        {"logical_name": "gpt-4"},
        {"logical_name": "gpt-3.5-turbo"},
    ]
    config_manager.env = {"OPENAI_API_KEY": "sk-test"}
    config_manager.config_dir = Path("/tmp/test")

    status = get_setup_status(config_manager)

    assert status["providers_count"] == 1
    assert status["models_count"] == 2
    assert status["enabled_providers"] == 1
    assert status["api_keys_count"] == 1
    assert status["providers_with_keys"] == 1
    assert status["progress_percentage"] == 100


def test_get_setup_status_with_disabled_providers():
    """Test setup status correctly handles disabled providers."""
    config_manager = Mock()
    config_manager.get_providers.return_value = {
        "openai": {
            "enabled": True,
            "api_keys": {"env_var_patterns": ["OPENAI_API_KEY"]},
        },
        "anthropic": {
            "enabled": False,
            "api_keys": {"env_var_patterns": ["ANTHROPIC_API_KEY"]},
        },
    }
    config_manager.get_models.return_value = []
    config_manager.env = {}
    config_manager.config_dir = Path("/tmp/test")

    status = get_setup_status(config_manager)

    assert status["providers_count"] == 2
    assert status["enabled_providers"] == 1
    # Disabled provider keys shouldn't be counted, and we have no env vars
    assert status["api_keys_count"] == 0
    assert status["providers_with_keys"] == 0


def test_get_setup_status_indexed_patterns():
    """Test setup status with indexed environment variable patterns."""
    config_manager = Mock()
    config_manager.get_providers.return_value = {
        "openai": {
            "enabled": True,
            "api_keys": {"env_var_patterns": ["OPENAI_{INDEX}_API_KEY"]},
        },
    }
    config_manager.get_models.return_value = []
    config_manager.env = {
        "OPENAI_1_API_KEY": "sk-test1",
        "OPENAI_2_API_KEY": "sk-test2",
        "OPENAI_3_API_KEY": "sk-test3",
    }
    config_manager.config_dir = Path("/tmp/test")

    status = get_setup_status(config_manager)

    assert status["api_keys_count"] == 3
    assert status["providers_with_keys"] == 1


def test_get_setup_status_recommendations():
    """Test that appropriate recommendations are generated."""
    config_manager = Mock()
    config_manager.get_providers.return_value = {}
    config_manager.get_models.return_value = []
    config_manager.env = {}
    config_manager.config_dir = Path("/tmp/test")

    status = get_setup_status(config_manager)

    # Should recommend adding providers
    assert any("provider" in r.lower() for r in status["recommendations"])


def test_get_setup_status_recommendations_partial():
    """Test recommendations when only providers are configured."""
    config_manager = Mock()
    config_manager.get_providers.return_value = {
        "openai": {
            "enabled": True,
            "api_keys": {"env_var_patterns": ["OPENAI_API_KEY"]},
        },
    }
    config_manager.get_models.return_value = []
    config_manager.env = {}
    config_manager.config_dir = Path("/tmp/test")

    status = get_setup_status(config_manager)

    # Should recommend models and API keys
    rec_text = " ".join(status["recommendations"]).lower()
    assert "model" in rec_text or "api key" in rec_text


# ============================================================================
# should_skip_step Tests
# ============================================================================


def test_should_skip_step_providers():
    """Test providers step skipping logic."""
    config_manager = Mock()

    # Should not skip providers when none configured
    config_manager.get_providers.return_value = {}
    assert not should_skip_step("providers", config_manager)

    # Should skip when providers exist
    config_manager.get_providers.return_value = {"openai": {"enabled": True}}
    assert should_skip_step("providers", config_manager)


def test_should_skip_step_models():
    """Test models step skipping logic."""
    config_manager = Mock()

    # Should not skip models when none configured
    config_manager.get_models.return_value = []
    config_manager.get_providers.return_value = {}
    assert not should_skip_step("models", config_manager)

    # Should skip when models exist AND providers exist
    config_manager.get_models.return_value = [{"logical_name": "gpt-4"}]
    config_manager.get_providers.return_value = {"openai": {"enabled": True}}
    assert should_skip_step("models", config_manager)

    # Should not skip if models exist but no providers
    config_manager.get_models.return_value = [{"logical_name": "gpt-4"}]
    config_manager.get_providers.return_value = {}
    assert not should_skip_step("models", config_manager)


def test_should_skip_step_api_keys():
    """Test API keys step skipping logic."""
    config_manager = Mock()
    config_manager.get_providers.return_value = {
        "openai": {
            "enabled": True,
            "api_keys": {"env_var_patterns": ["OPENAI_API_KEY"]},
        },
    }
    config_manager.env = {}

    # Should not skip when no keys configured
    assert not should_skip_step("api_keys", config_manager)

    # Should skip when all enabled providers have keys
    config_manager.env = {"OPENAI_API_KEY": "sk-test"}
    assert should_skip_step("api_keys", config_manager)

    # Should not skip when some providers missing keys
    config_manager.get_providers.return_value = {
        "openai": {
            "enabled": True,
            "api_keys": {"env_var_patterns": ["OPENAI_API_KEY"]},
        },
        "anthropic": {
            "enabled": True,
            "api_keys": {"env_var_patterns": ["ANTHROPIC_API_KEY"]},
        },
    }
    config_manager.env = {"OPENAI_API_KEY": "sk-test"}
    assert not should_skip_step("api_keys", config_manager)


def test_should_skip_step_disabled_providers():
    """Test that disabled providers don't affect skipping."""
    config_manager = Mock()
    config_manager.get_providers.return_value = {
        "openai": {
            "enabled": True,
            "api_keys": {"env_var_patterns": ["OPENAI_API_KEY"]},
        },
        "anthropic": {
            "enabled": False,
            "api_keys": {"env_var_patterns": ["ANTHROPIC_API_KEY"]},
        },
    }
    config_manager.env = {"OPENAI_API_KEY": "sk-test"}

    # Should skip because the only enabled provider has a key
    assert should_skip_step("api_keys", config_manager)


def test_should_skip_step_unknown():
    """Test handling of unknown step types."""
    config_manager = Mock()

    # Unknown steps should not be skipped
    assert not should_skip_step("unknown_step", config_manager)


# ============================================================================
# Progress Persistence Tests
# ============================================================================


def test_save_and_load_progress():
    """Test saving and loading progress from file."""
    progress_data = {
        "completed_steps": ["providers", "models"],
        "current_step": "api_keys",
        "setup_type": "guided",
    }

    with tempfile.TemporaryDirectory() as tmpdir:
        file_path = Path(tmpdir) / "wizard_progress.json"

        save_progress_to_file(progress_data, str(file_path))
        loaded = load_progress_from_file(str(file_path))

        assert loaded is not None
        assert loaded["completed_steps"] == ["providers", "models"]
        assert loaded["current_step"] == "api_keys"
        assert loaded["setup_type"] == "guided"


def test_load_progress_no_file():
    """Test loading progress when file doesn't exist."""
    with tempfile.TemporaryDirectory() as tmpdir:
        file_path = Path(tmpdir) / "nonexistent.json"
        loaded = load_progress_from_file(str(file_path))
        assert loaded is None


def test_load_progress_invalid_json():
    """Test loading progress from corrupt file."""
    with tempfile.TemporaryDirectory() as tmpdir:
        file_path = Path(tmpdir) / "corrupt.json"
        file_path.write_text("{ invalid json }")
        loaded = load_progress_from_file(str(file_path))
        assert loaded is None


def test_clear_progress_file():
    """Test clearing progress file."""
    with tempfile.TemporaryDirectory() as tmpdir:
        file_path = Path(tmpdir) / "wizard_progress.json"
        file_path.write_text('{"test": "data"}')

        clear_progress_file(str(file_path))
        assert not file_path.exists()


def test_clear_nonexistent_progress_file():
    """Test clearing a nonexistent progress file (should not error)."""
    with tempfile.TemporaryDirectory() as tmpdir:
        file_path = Path(tmpdir) / "nonexistent.json"
        # Should not raise an error
        clear_progress_file(str(file_path))


# ============================================================================
# get_step_name Tests
# ============================================================================


def test_get_step_name_providers():
    """Test getting provider step name."""
    assert get_step_name("providers") == "Provider Configuration"


def test_get_step_name_models():
    """Test getting models step name."""
    assert get_step_name("models") == "Model Configuration"


def test_get_step_name_api_keys():
    """Test getting API keys step name."""
    assert get_step_name("api_keys") == "API Key Setup"


def test_get_step_name_unknown():
    """Test getting unknown step name (should capitalize)."""
    assert get_step_name("unknown") == "Unknown"


# ============================================================================
# validate_prerequisites Tests
# ============================================================================


def test_validate_prerequisites_models():
    """Test prerequisites for models step."""
    config_manager = Mock()

    # Models require providers
    config_manager.get_providers.return_value = {}
    met, missing = validate_prerequisites("models", config_manager)
    assert not met
    assert "Providers must be configured first" in missing

    # Prerequisites met when providers exist
    config_manager.get_providers.return_value = {"openai": {"enabled": True}}
    met, missing = validate_prerequisites("models", config_manager)
    assert met
    assert len(missing) == 0


def test_validate_prerequisites_api_keys():
    """Test prerequisites for API keys step."""
    config_manager = Mock()

    # API keys require providers
    config_manager.get_providers.return_value = {}
    met, missing = validate_prerequisites("api_keys", config_manager)
    assert not met
    assert "Providers must be configured first" in missing

    # API keys require at least one enabled provider
    config_manager.get_providers.return_value = {
        "openai": {"enabled": False},
        "anthropic": {"enabled": False},
    }
    met, missing = validate_prerequisites("api_keys", config_manager)
    assert not met
    assert "At least one provider must be enabled" in missing

    # Prerequisites met when enabled provider exists
    config_manager.get_providers.return_value = {
        "openai": {"enabled": True},
    }
    met, missing = validate_prerequisites("api_keys", config_manager)
    assert met
    assert len(missing) == 0


def test_validate_prerequisites_unknown_step():
    """Test prerequisites for unknown step."""
    config_manager = Mock()
    met, missing = validate_prerequisites("unknown", config_manager)
    assert met  # Unknown steps have no prerequisites
    assert len(missing) == 0


# ============================================================================
# format_model_config_summary Tests
# ============================================================================


def test_format_model_config_summary_empty():
    """Test formatting empty model list."""
    summary = format_model_config_summary([])
    assert summary == "No models configured"


def test_format_model_config_summary_single():
    """Test formatting single model."""
    models = [
        {
            "logical_name": "gpt-4",
            "model_routings": [{"provider": "openai"}],
            "fallback_model_routings": [],
        }
    ]
    summary = format_model_config_summary(models)
    assert "gpt-4" in summary
    assert "1 route" in summary


def test_format_model_config_summary_multiple():
    """Test formatting multiple models."""
    models = [
        {
            "logical_name": "gpt-4",
            "model_routings": [1, 2],
            "fallback_model_routings": [1],
        },
        {
            "logical_name": "gpt-3.5-turbo",
            "model_routings": [1],
            "fallback_model_routings": [1, 2],
        },
        {
            "logical_name": "claude-3-opus",
            "model_routings": [1, 2, 3],
            "fallback_model_routings": [],
        },
    ]
    summary = format_model_config_summary(models)
    assert "gpt-4" in summary
    assert "gpt-3.5-turbo" in summary
    assert "claude-3-opus" in summary


def test_format_model_config_summary_truncated():
    """Test truncation when more than 5 models."""
    models = [
        {
            "logical_name": f"model-{i}",
            "model_routings": [1],
            "fallback_model_routings": [],
        }
        for i in range(7)
    ]
    summary = format_model_config_summary(models)
    assert "model-0" in summary
    assert "and 2 more models" in summary


def test_format_model_config_summary_no_routing_info():
    """Test formatting models without routing info."""
    models = [
        {"logical_name": "test-model"},  # No routing info
    ]
    summary = format_model_config_summary(models)
    assert "test-model" in summary


# ============================================================================
# SetupWizard Integration Tests
# ============================================================================


def test_setup_wizard_initialization():
    """Test SetupWizard initialization."""
    from app.cli.setup_wizard import SetupWizard

    wizard = SetupWizard()

    assert wizard.completed_steps == []
    assert wizard.total_steps == 3
    assert wizard.setup_type == "guided"
    assert wizard.config_manager is not None


# Test SetupWizard integration with wizard utilities
def test_setup_wizard_integration():
    """Test SetupWizard integration with wizard utilities."""
    from app.cli.setup_wizard import SetupWizard

    wizard = SetupWizard()

    # Test that wizard has the expected methods
    assert hasattr(wizard, "run")
    assert hasattr(wizard, "save_progress")
    assert hasattr(wizard, "show_welcome")
    assert hasattr(wizard, "show_progress")
    assert hasattr(wizard, "generate_summary")

    # Test step execution methods
    assert hasattr(wizard, "run_provider_setup")
    assert hasattr(wizard, "run_model_setup")
    assert hasattr(wizard, "run_api_key_setup")


def test_setup_wizard_get_step_name():
    """Test SetupWizard step name retrieval."""
    from app.cli.setup_wizard import SetupWizard

    wizard = SetupWizard()

    # Test the wizard's internal step name method
    # Note: This is private method, testing for completeness
    assert wizard._get_step_name(1) == "providers"
    assert wizard._get_step_name(2) == "models"
    assert wizard._get_step_name(3) == "api_keys"
    assert wizard._get_step_name(0) == "unknown"  # Invalid step


# ============================================================================
# display_setup_status Tests (using capsys for output capture)
# ============================================================================


def test_display_setup_status_empty(capsys):
    """Test displaying setup status for empty config."""
    config_manager = Mock()
    config_manager.get_providers.return_value = {}
    config_manager.get_models.return_value = []
    config_manager.env = {}
    config_manager.config_dir = Path("/tmp/test")

    display_setup_status(config_manager)

    captured = capsys.readouterr()
    output = captured.out

    assert "Current Setup Status" in output
    assert "0/0 enabled" in output or "0 configured" in output


def test_display_setup_status_partial(capsys):
    """Test displaying setup status for partial config."""
    config_manager = Mock()
    config_manager.get_providers.return_value = {
        "openai": {
            "enabled": True,
            "api_keys": {"env_var_patterns": ["OPENAI_API_KEY"]},
        }
    }
    config_manager.get_models.return_value = []
    config_manager.env = {}
    config_manager.config_dir = Path("/tmp/test")

    display_setup_status(config_manager)

    captured = capsys.readouterr()
    output = captured.out

    assert "Current Setup Status" in output
    assert "1/1 enabled" in output
    assert "Models:" in output or "models" in output.lower()


# ============================================================================
# Edge Case Tests
# ============================================================================


def test_progress_bar_current_greater_than_total():
    """Test progress bar handles current > total gracefully."""
    # Test with a more reasonable scenario where current is slightly larger than total
    bar = create_progress_bar(6, 5, width=20)
    # Should show 120% and fill most of the bar
    assert "120%" in bar
    # Should have filled characters but not exceed width
    assert bar.count("█") >= 16  # At least 80% filled


def test_progress_bar_negative_current():
    """Test progress bar with negative current."""
    bar = create_progress_bar(-1, 10, width=20)
    # Should handle gracefully
    assert "%" in bar


def test_format_step_status_unicode():
    """Test that Unicode symbols work correctly."""
    status = format_step_status("test", True)
    assert "✓" in status or ";" in status

    status = format_step_status("test", False)
    assert "]" in status  # The empty brackets [ ]


def test_get_setup_status_no_api_keys_section():
    """Test setup status when provider has no api_keys section."""
    config_manager = Mock()
    config_manager.get_providers.return_value = {
        "openai": {"enabled": True},  # No api_keys section
    }
    config_manager.get_models.return_value = []
    config_manager.env = {}
    config_manager.config_dir = Path("/tmp/test")

    # Should not error
    status = get_setup_status(config_manager)
    assert status["api_keys_count"] == 0
    assert status["providers_with_keys"] == 0


def test_get_setup_status_empty_patterns():
    """Test setup status when provider has empty env_var_patterns."""
    config_manager = Mock()
    config_manager.get_providers.return_value = {
        "openai": {
            "enabled": True,
            "api_keys": {"env_var_patterns": []},  # Empty patterns
        }
    }
    config_manager.get_models.return_value = []
    config_manager.env = {}
    config_manager.config_dir = Path("/tmp/test")

    # Should not error
    status = get_setup_status(config_manager)
    assert status["api_keys_count"] == 0
    assert status["providers_with_keys"] == 0
