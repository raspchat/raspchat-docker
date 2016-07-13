FROM buildpack-deps:jessie-scm
MAINTAINER Florian Wartner <hi@florianwartner.co>

# Set up dependencies
RUN curl -sL https://deb.nodesource.com/setup_0.12 | bash -
RUN apt-get update && apt-get install -y --no-install-recommends \
		g++ \
		gcc \
		libc6-dev \
		make \
		git \
		nodejs \
	&& rm -rf /var/lib/apt/lists/*

ENV GOLANG_VERSION 1.6.2
ENV GOLANG_DOWNLOAD_URL https://golang.org/dl/go$GOLANG_VERSION.linux-amd64.tar.gz
ENV GOLANG_DOWNLOAD_SHA256 e40c36ae71756198478624ed1bb4ce17597b3c19d243f3f0899bb5740d56212a

RUN curl -fsSL "$GOLANG_DOWNLOAD_URL" -o golang.tar.gz \
	&& echo "$GOLANG_DOWNLOAD_SHA256  golang.tar.gz" | sha256sum -c - \
	&& tar -C /usr/local -xzf golang.tar.gz \
	&& rm golang.tar.gz

ENV GOPATH /go
ENV PATH $GOPATH/bin:/usr/local/go/bin:$PATH

RUN mkdir -p "$GOPATH/src" "$GOPATH/bin" && chmod -R 777 "$GOPATH"
WORKDIR $GOPATH

COPY go-wrapper /usr/local/bin/

# Set up raspchat
ENV RASPCHAT_REPOSITORY "https://github.com/maxpert/raspchat.git"
ENV RASPCHAT_DIR "~/raspchat"
RUN cd ~/ && git clone $RASPCHAT_REPOSITORY raspchat

RUN ./get_dependencies.sh
RUN cd ~/raspchat && rm -rf dist && mkdir -p dist && mkdir -p dist/static && ./build_server.sh
COPY -R static/* ~/raspchat/dist/static/
RUN CD ~/raspchat/dist/ && ./chat-server

# RUN curl -fsSL https://raw.githubusercontent.com/raspchat/raspchat-docker/master/raspchat_d -o raspchat && update-rc.d raspchat defaults