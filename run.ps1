param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ArgsList
)
python -m claude_duo.cli @ArgsList
