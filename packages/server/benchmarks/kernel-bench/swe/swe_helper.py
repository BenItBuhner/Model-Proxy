"""SWE-bench Verified helper (run with the swebench==4.x venv).

Subcommands (all read a JSON instance from --instance):
  spec        -> {python, pre_install[], install, pip_packages[], packages, requirements, test_cmd, directives[], start, end}
  grade LOG   -> {resolved, status, f2p: {success, failure}, p2p: {success, failure}, parsed}

The grading path is the official one: the repo's log parser over the output
between the START/END markers, then get_eval_tests_report/get_resolution_status.
"""

import argparse
import json
import sys

from swebench.harness.constants import (
    END_TEST_OUTPUT,
    FAIL_TO_PASS,
    KEY_INSTANCE_ID,
    KEY_PREDICTION,
    PASS_TO_PASS,
    START_TEST_OUTPUT,
)
from swebench.harness.grading import get_eval_tests_report, get_resolution_status
from swebench.harness.log_parsers import MAP_REPO_TO_PARSER
from swebench.harness.test_spec.python import MAP_REPO_VERSION_TO_SPECS, get_requirements, get_test_directives
from swebench.harness.test_spec.test_spec import make_test_spec


def load_instance(path):
    with open(path) as f:
        inst = json.load(f)
    for key in (FAIL_TO_PASS, PASS_TO_PASS):
        if isinstance(inst.get(key), str):
            inst[key] = json.loads(inst[key])
    return inst


def cmd_spec(inst):
    spec = MAP_REPO_VERSION_TO_SPECS[inst["repo"]][inst["version"]]
    requirements = None
    if spec.get("packages") == "requirements.txt":
        try:
            requirements = get_requirements(inst)
        except Exception as exc:  # network / missing file
            requirements = None
            sys.stderr.write(f"requirements lookup failed: {exc}\n")
    test_cmd = spec["test_cmd"]
    if isinstance(test_cmd, list):
        test_cmd = test_cmd[-1]
    out = {
        "python": spec["python"],
        "pre_install": spec.get("pre_install", []),
        "install": spec.get("install", ""),
        "pip_packages": spec.get("pip_packages", []),
        "packages": spec.get("packages", ""),
        "requirements": requirements,
        "test_cmd": test_cmd,
        "directives": get_test_directives(inst),
        "start": START_TEST_OUTPUT,
        "end": END_TEST_OUTPUT,
    }
    print(json.dumps(out))


def cmd_grade(inst, log_path):
    with open(log_path) as f:
        content = f.read()
    if START_TEST_OUTPUT not in content or END_TEST_OUTPUT not in content:
        print(json.dumps({"resolved": False, "status": "NO_TEST_OUTPUT", "parsed": False}))
        return
    body = content.split(START_TEST_OUTPUT)[1].split(END_TEST_OUTPUT)[0]
    test_spec = make_test_spec(inst)
    status_map = MAP_REPO_TO_PARSER[inst["repo"]](body, test_spec)
    gold = {FAIL_TO_PASS: inst[FAIL_TO_PASS], PASS_TO_PASS: inst[PASS_TO_PASS]}
    report = get_eval_tests_report(status_map, gold)
    status = get_resolution_status(report)
    print(json.dumps({
        "resolved": status == "RESOLVED_FULL",
        "status": status,
        "f2p": {"success": len(report[FAIL_TO_PASS]["success"]), "failure": len(report[FAIL_TO_PASS]["failure"])},
        "p2p": {"success": len(report[PASS_TO_PASS]["success"]), "failure": len(report[PASS_TO_PASS]["failure"])},
        "parsed": True,
        "tests_seen": len(status_map),
    }))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["spec", "grade"])
    ap.add_argument("--instance", required=True)
    ap.add_argument("--log")
    args = ap.parse_args()
    inst = load_instance(args.instance)
    if args.command == "spec":
        cmd_spec(inst)
    else:
        cmd_grade(inst, args.log)


if __name__ == "__main__":
    main()
