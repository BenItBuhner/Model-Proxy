| instance | difficulty | glm-5.3 | kimi-k3 | deepseek-v4-pro-0813 | fusion-max (v55) | fusion s / steps |
|---|---|---|---|---|---|---|
| **sample A (deterministic, all tiers)** | |  |  |  |  | |
| pytest-dev__pytest-5262 | <15 min fix | ✓ | ✓ | ✓ | ✓ | 177 / 13 |
| sympy__sympy-19346 | 15 min - 1 hour | ✓ | ✓ | ✓ | ✓ | 363 / 20 |
| pallets__flask-5014 | <15 min fix | ✓ | ✓ | ✓ | ✓ | 126 / 7 |
| sympy__sympy-23824 | 15 min - 1 hour | ✓ | ✓ | ✓ | ✓ | 185 / 9 |
| sympy__sympy-21379 | 15 min - 1 hour | ✓ | ✓ | ✓ | ✓ | 918 / 30 |
| pytest-dev__pytest-7982 | <15 min fix | ✓ | ✓ | ✓ | ✓ | 185 / 8 |
| psf__requests-1142 | <15 min fix | ✓ | ✓ | ✓ | ✓ | 299 / 12 |
| sympy__sympy-16792 | 15 min - 1 hour | ✓ | ✗ | ✗ | ✓ | 598 / 29 |
| pytest-dev__pytest-6197 | 1-4 hours | ✗ | ✗ | ✗ | ✓ | 1925 / 21 |
| django__django-14238 | 15 min - 1 hour | ✓ | ✓ | ✓ | ✓ | 229 / 14 |
| sympy__sympy-22914 | 15 min - 1 hour | ✓ | ✓ | ✓ | ✓ | 117 / 6 |
| django__django-16139 | <15 min fix | ✓ | ✓ | ✓ | ✓ | 196 / 14 |
| *sample A total* | | **11/12** | **10/12** | **10/12** | **12/12** | |
| **sample B (hard tiers: 1–4 h, >4 h)** | |  |  |  |  | |
| django__django-15629 | 1-4 hours | ✓ | ✓ | ✓ | ✓ | 1173 / 40 |
| django__django-14631 | 1-4 hours | ✓ | ✓ | ✓ | ✓ | 1059 / 28 |
| pytest-dev__pytest-6197 | 1-4 hours | ✗ | ✗ | ✗ | ✓ | 1925 / 21 |
| django__django-14011 | 1-4 hours | ✓ | ✓ | ✓ | ✓ | 3295 / 47 |
| django__django-16631 | 1-4 hours | ✓ | ✓ | ✓ | ✓ | 886 / 30 |
| pytest-dev__pytest-10356 | 1-4 hours | ✓ | ✓ | ✓ | ✓ | 527 / 20 |
| pytest-dev__pytest-5787 | 1-4 hours | ✗ | ✓ | ✓ | ✓ | 769 / 33 |
| django__django-16560 | 1-4 hours | ✓ | ✓ | ✓ | ✓ | 1275 / 50 |
| sympy__sympy-13878 | >4 hours | ✗ | ✗ | ✓ | ✓ | 1590 / 49 |
| django__django-16263 | 1-4 hours | ✓ | ✗ | ✓ | ✓ | 1287 / 40 |
| django__django-15503 | 1-4 hours | ✓ | ✗ | ✓ | ✓ | 380 / 17 |
| django__django-15957 | 1-4 hours | ✓ | ✓ | ✓ | ✓ | 655 / 34 |
| *sample B total* | | **9/12** | **8/12** | **11/12** | **12/12** | |
| **all 23 instances** | | **20/23** | **18/23** | **21/23** | **23/23** | |
| union of members | | 22/23 | | | | |

Latency (s, per instance, incl. environment setup) p50 / p90: glm-5.3 437 / 964; kimi-k3 536 / 1121; deepseek-v4-pro-0813 199 / 283; fusion-max (v55) 598 / 1590
Median agent steps: glm-5.3 32; kimi-k3 38; deepseek-v4-pro-0813 40; fusion-max (v55) 21
