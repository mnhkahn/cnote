#!/usr/bin/env python3
"""Validate release versions and generate the macOS bundle metadata."""
import argparse
import base64
import os
import platform
import pathlib
import plistlib
import re
import subprocess


def version_number(tag):
    if not re.fullmatch(r"[vV]?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", tag):
        raise ValueError("Expected a stable version such as v1.2.3, V1.2.3 or 1.2.3")
    return tag.lstrip("vV")


def resolve_version(tag="", root=None):
    if tag:
        return version_number(tag)
    root = root or pathlib.Path(__file__).resolve().parent.parent
    result = subprocess.run(
        ["git", "tag", "--merged", "HEAD"], cwd=root,
        capture_output=True, text=True, check=False,
    )
    versions = []
    if result.returncode == 0:
        for candidate in result.stdout.splitlines():
            try:
                versions.append(version_number(candidate))
            except ValueError:
                continue
    if not versions:
        raise ValueError("No reachable stable Git tag; fetch tags or pass --version v1.2.3 explicitly")
    return max(versions, key=lambda value: tuple(map(int, value.split("."))))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", default="")
    parser.add_argument("--output", type=pathlib.Path)
    parser.add_argument("--arch", choices=["arm64", "x86_64"], default=os.environ.get("RELEASE_ARCH", platform.machine()))
    args = parser.parse_args()
    try:
        version = resolve_version(args.version)
    except ValueError as error:
        parser.error(str(error))
    if args.output:
        info = {
            "CFBundleName": "CNote", "CFBundleDisplayName": "CNote",
            "CFBundleIdentifier": "com.cyeam.cnote", "CFBundleExecutable": "CNote",
            "CFBundleURLTypes": [{
                "CFBundleURLName": "com.cyeam.cnote",
                "CFBundleURLSchemes": ["cnote"],
                "CFBundleTypeRole": "Viewer",
            }],
            "CFBundleIconFile": "AppIcon", "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": version, "CFBundleVersion": version,
            "LSMinimumSystemVersion": "14.0", "NSHighResolutionCapable": True,
        }
        key_file = pathlib.Path(__file__).resolve().parent.parent / "assets/update-public-key.txt"
        if not key_file.exists():
            parser.error("Missing assets/update-public-key.txt; configure the update signing key first")
        if key_file.exists():
            public_key = key_file.read_text().strip()
            try:
                if len(base64.b64decode(public_key, validate=True)) != 32:
                    raise ValueError("Expected a 32-byte Ed25519 public key")
            except (ValueError, base64.binascii.Error) as error:
                parser.error(str(error))
            repo = os.environ.get("CNOTE_UPDATE_REPOSITORY", "mnhkahn/cnote")
            if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
                parser.error("Invalid update repository")
            info.update({
                "SUPublicEDKey": public_key,
                "SUFeedURL": f"https://github.com/{repo}/releases/latest/download/appcast-{args.arch}.xml",
                "SUEnableAutomaticChecks": True,
                "SUAutomaticallyUpdate": True,
                "SUAllowsAutomaticUpdates": True,
                "SUScheduledCheckInterval": 3600,
                "SUEnableSystemProfiling": False,
                "SUVerifyUpdateBeforeExtraction": True,
                "SURequireSignedFeed": True,
                "SUSignedFeedFailureExpirationInterval": 0,
            })
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(plistlib.dumps(info))
    print(version)


if __name__ == "__main__":
    main()
