FROM node:22-trixie

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

USER node

WORKDIR /workspace

CMD ["bash"]
