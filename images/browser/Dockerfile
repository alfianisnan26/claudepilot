# The browser container (browser & desktop PRD §10.1, §14.1): Chromium, TigerVNC's Xvnc (the virtual display and
# the VNC server in one process, reachable only on a unix socket) and the supervisor that runs them. It joins one
# workspace's network namespace, so CDP stays on that workspace's 127.0.0.1 and nothing is published. Docker
# targets build it on first use (a bare tag like claudepilot-browser:latest comes from this folder).
FROM node:22-trixie-slim

ARG DEBIAN_FRONTEND=noninteractive
# One layer for everything heavy, so changes to our own scripts (below) rebuild in seconds.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       chromium tigervnc-standalone-server openbox xdotool scrot xclip xauth socat x11-utils x11-xserver-utils \
       fonts-liberation fonts-noto-color-emoji fonts-noto-core fonts-dejavu-core \
       ca-certificates procps tini \
    && rm -rf /var/lib/apt/lists/*

# uid 1000 (node, from the base image) runs Chromium; uid 1001 runs the display, the VNC servers and the
# supervisor, and owns the control socket, so a compromised renderer can't reach any of them (PRD §13 Users).
RUN groupadd -g 1001 cpb && useradd -u 1001 -g 1001 -M -d /nonexistent -s /usr/sbin/nologin cpb

# The X socket folder, sticky and world-writable as X expects, made here because the display runs as a non-root user.
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

COPY cpb/ /opt/cpb/
RUN chmod 0755 /opt/cpb /opt/cpb/*.mjs /opt/cpb/cpb-ctl /opt/cpb/cpb-vnc /opt/cpb/cpb-view \
    && ln -s /opt/cpb/cpb-ctl /usr/local/bin/cpb-ctl && ln -s /opt/cpb/cpb-vnc /usr/local/bin/cpb-vnc && ln -s /opt/cpb/cpb-view /usr/local/bin/cpb-view \
    && mkdir -p /etc/cpb /etc/chromium/policies/managed /data/profile /home/node/Downloads \
    && chown 1000:1000 /data/profile /home/node/Downloads && chmod 0700 /data/profile

ENV LANG=C.UTF-8 NODE_OPTIONS=--disable-warning=ExperimentalWarning
# The root init (holding only SETUID and SETGID, PRD §10.1) starts everything else; Docker's `Init: true` is PID 1. On Kubernetes
# (no such option) the pod runs it under `tini`, so the processes Chrome leaves behind are reaped.
ENTRYPOINT ["node", "/opt/cpb/init.mjs"]
