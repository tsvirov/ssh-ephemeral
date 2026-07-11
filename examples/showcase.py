#!/usr/bin/env python3
"""Stylized terminal showcase of ssh-ephemeral, for recording a README GIF.

This is a scripted VISUALIZATION of ssh-ephemeral's real behavior — the
timings are compressed and the panels are art-directed for the camera. Every
piece of data on screen (the sandbox id format, the config fields, the
janitor log line) matches the real implementation exactly. For genuine,
unedited tool output, run `./examples/demo.sh` instead — that one actually
starts the server and connects over real SSH.

Requires: pip install rich
Run:      python examples/showcase.py
"""

import random
import string
import time

from rich.console import Console, Group
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from rich.progress import Progress, BarColumn, TextColumn
from rich.status import Status

console = Console()


def beat(seconds: float) -> None:
    time.sleep(seconds)


def success(msg: str) -> None:
    console.print(f"  [bold green]SUCCESS[/] {msg}")


def info(msg: str) -> None:
    console.print(f"  [dim]{msg}[/]")


def sandbox_id(user: str) -> str:
    # Mirrors the real format from src/session-manager.ts:
    # `${username}-${clock()}-${random6}`
    epoch_ms = int(time.time() * 1000)
    rand6 = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
    return f"{user}-{epoch_ms}-{rand6}"


def main() -> None:
    console.print()
    console.print(
        Panel(
            Text("ssh-ephemeral", style="bold cyan", justify="center")
            + Text("\nSSH into a fresh sandbox — no manual provisioning, no leftover state.", justify="center"),
            border_style="cyan",
        )
    )
    console.print()

    with Status("[bold]Starting ssh-ephemeral server...[/]", spinner="dots"):
        beat(0.9)
    success("Listening on :2222  [dim](LocalProcessDriver — no Docker required)[/]")
    console.print()

    with Status("[bold]$[/] ssh dev@host", spinner="dots"):
        beat(0.7)
    success('Authenticated "dev" via publickey')
    console.print()

    steps = [
        ("look up user -> template", 0.25),
        ("provision(template, sessionId)", 0.35),
        ("attach(sandbox) -> shell stream", 0.25),
    ]
    with Progress(
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
        console=console,
        transient=True,
    ) as progress:
        task = progress.add_task("provisioning sandbox", total=100)
        for label, dur in steps:
            progress.update(task, description=label)
            for _ in range(10):
                beat(dur / 10)
                progress.advance(task, 100 / len(steps) / 10)

    sid = sandbox_id("dev")
    success(f"sandbox ready  [bold]{sid}[/]")
    console.print()

    table = Table(show_header=True, header_style="bold magenta", border_style="dim")
    table.add_column("command")
    table.add_column("output")
    table.add_row("echo $SSH_EPHEMERAL_SESSION", sid)
    table.add_row("whoami", "dev")
    console.print(Panel(table, title="[dim]inside the sandbox[/]", border_style="dim"))
    console.print()

    with Status("[bold]client disconnects[/] — reconnectGraceSeconds window open", spinner="dots"):
        beat(1.0)
    info("no reconnect within the grace window")

    with Status("[bold]janitor sweep[/]", spinner="dots"):
        beat(0.8)
    console.print(f"  [bold red]FLAG[/] [dim][janitor] evicted-idle sandbox={sid} user=dev[/]")
    success("sandbox destroyed — zero leftover state")
    console.print()

    before_after = Table.grid(padding=(0, 2))
    before_after.add_column(justify="left")
    before_after.add_column(justify="left")
    before_after.add_row(
        Panel(
            "docker run -it --rm ... sh\n"
            "# forget --rm, or it gets killed mid-session\n"
            "docker rm $(docker ps -aq -f status=exited)",
            title="[red]before[/]",
            border_style="red",
        ),
        Panel(
            "ssh dev@host\n"
            "# work\n"
            "# disconnect — gone automatically",
            title="[green]after[/]",
            border_style="green",
        ),
    )
    console.print(before_after)

    console.print()
    console.print(
        Panel(
            Text("star tsvirov/ssh-ephemeral on GitHub", style="bold yellow", justify="center"),
            border_style="yellow",
        )
    )


if __name__ == "__main__":
    main()
