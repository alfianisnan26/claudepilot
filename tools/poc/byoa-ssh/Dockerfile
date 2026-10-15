FROM claudepilot-workspace:cc-2.1.296
USER root
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends openssh-server >/dev/null \
 && rm -f /etc/ssh/ssh_host_* && mkdir -p /run/sshd && rm -rf /var/lib/apt/lists/* && /usr/sbin/sshd -V 2>&1 | head -1
USER node
