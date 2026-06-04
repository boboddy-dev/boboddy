FROM mcr.microsoft.com/playwright/mcp:v0.0.68

USER root

ARG OPENCODE_NPM_PACKAGE=opencode-ai@1.15.13
ARG OPENCODE_PLUGIN_SDK_PACKAGE=@opencode-ai/plugin@1.15.13

ENV DEBIAN_FRONTEND=noninteractive
ENV OPENCODE_HOME=/home/node
ENV PATH=/usr/local/bin:${PATH}

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    python3 \
    python3-pip \
    python-is-python3 \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global "${OPENCODE_NPM_PACKAGE}" \
  && npm cache clean --force

RUN mkdir -p /opt/boboddy/opencode-runtime \
  && npm install --prefix /opt/boboddy/opencode-runtime --no-audit --no-fund --silent "${OPENCODE_PLUGIN_SDK_PACKAGE}" \
  && npm cache clean --force

RUN mkdir -p /opt/uv-python \
  && python3 -m pip install --no-cache-dir --break-system-packages uv \
  && uv --version \
  && uvx --version

ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python
ENV UV_TOOL_DIR=/opt/uv-tools
RUN uv tool install playwright-trace-analyzer \
  && ln -sf /opt/uv-tools/playwright-trace-analyzer/bin/playwright-trace-analyzer /usr/local/bin/playwright-trace-analyzer \
  && chmod +x /opt/uv-tools/playwright-trace-analyzer/bin/playwright-trace-analyzer \
  && chown -R node:node /opt/uv-tools/

RUN mkdir -p /workspace "${OPENCODE_HOME}" \
  && chown -R node:node /workspace "${OPENCODE_HOME}"

COPY packages/containers/ai-worker/entrypoint.sh /usr/local/bin/opencode-entrypoint
RUN chmod +x /usr/local/bin/opencode-entrypoint

COPY packages/opencode-plugin/dist/plugin.js /opt/boboddy/plugin.js
RUN chown -R node:node /opt/boboddy

USER node
WORKDIR /workspace

EXPOSE 4096

ENTRYPOINT ["/usr/local/bin/opencode-entrypoint"]
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
