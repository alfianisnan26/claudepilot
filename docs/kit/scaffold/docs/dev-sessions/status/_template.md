# Orchestrator status (<YYYY-MM-DD HH:MM>, session <id>)

<!-- The shape of status/orchestrator.md. At most 80 lines, overwritten, committed with the work. Failures first.
     The first line becomes `TRACK COMPLETE` when the backlog is empty. Delete these comment lines. -->

## DONE
- T-<n> <what, in a few words>: <commit>, gate <quick|full> <green|red> (<evidence link or log path>).

## IN FLIGHT (at most five)
- <label> (<model>): T-<n>, branch `ticket/T-<n>-<slug>`, worktree `<path>`. Left: <what>.

## DECISIONS
- <decision>: options <a | b>, default <a>, because <reason>. Ticket T-<n>. <D-n if it became a standing row>

## NEEDS A HUMAN
- <required escalation: production | uat | secrets and permissions | billing | legal | destructive data>:
  <exact steps for the person>. Ticket T-<n>.

## NEXT
1. T-<n> (rank-<NN>): <the next slice>.
2. T-<n> (rank-<NN>): <the one after>.
