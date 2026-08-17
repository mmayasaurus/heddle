# Issue tracking — heddle (core), team HED

**Team:** HED · **`LIN_TEAM=HED`** · CLI: `/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/bin/lin.sh --agent <letter>`

SPI-era rationale and fleet identity protocol: `/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/rules/issue-tracking.md`

## Protocol

**View → claim → branch/PR (`Fixes HED-n`) → resolve after merge.** Area labels are exclusive (one per issue). Release a claim you are not finishing (started or not) with `lin.sh unclaim HED-n` so it is not stranded on an absent agent. Full subcommand list: `lin.sh -h` (whoami / view / list / areas / claim / unclaim / mine / comment / resolve / done / create). New finding: `lin.sh create "<title>" --type <Bug|Chore|…> --area <Area> --priority <1-4>`
