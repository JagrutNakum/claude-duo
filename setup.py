from setuptools import setup, find_packages

setup(
    name="claude-duo",
    version="1.0.0",
    description="Shared Claude Account Usage Tracker & Alert System for Pairs",
    author="Antigravity",
    packages=find_packages(),
    python_requires=">=3.8",
    entry_points={
        "console_scripts": [
            "claude-duo=claude_duo.cli:main",
        ],
    },
)
