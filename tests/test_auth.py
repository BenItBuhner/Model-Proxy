"""
Tests for client authentication module.
"""

import pytest
from fastapi import HTTPException
from app.auth import verify_client_api_key, CLIENT_API_KEY


@pytest.mark.asyncio
async def test_verify_client_api_key_valid():
    """Test valid API key authentication."""
    # Mock the header with valid key
    result = await verify_client_api_key(authorization=f"Bearer {CLIENT_API_KEY}")
    assert result is True


@pytest.mark.asyncio
async def test_verify_client_api_key_valid_no_bearer():
    """Test valid API key without Bearer prefix."""
    result = await verify_client_api_key(authorization=CLIENT_API_KEY)
    assert result is True


@pytest.mark.asyncio
async def test_verify_client_api_key_invalid():
    """Test invalid API key authentication."""
    with pytest.raises(HTTPException) as exc_info:
        await verify_client_api_key(authorization="Bearer invalid_key")

    assert exc_info.value.status_code == 401
    assert "Invalid API key" in exc_info.value.detail


@pytest.mark.asyncio
async def test_verify_client_api_key_missing():
    """Test missing Authorization header."""
    with pytest.raises(HTTPException) as exc_info:
        await verify_client_api_key(authorization=None, x_api_key=None)

    assert exc_info.value.status_code == 401
    assert "Missing API key" in exc_info.value.detail


@pytest.mark.asyncio
async def test_verify_client_api_key_empty():
    """Test empty Authorization header."""
    with pytest.raises(HTTPException) as exc_info:
        await verify_client_api_key(authorization="", x_api_key=None)

    assert exc_info.value.status_code == 401
