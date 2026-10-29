# Asterisk 22.11.0 (>= 22.8: chan_websocket with JSON control and ARI externalMedia websocket),
# built from the verified release tarball. Runs as uid/gid 1500 with the host network.
# The tarball is fetched from releases/, where every version stays; the top directory keeps only
# the current one. The sha256 is the one downloads.asterisk.org publishes (asterisk-22.11.0.sha256),
# checked against the tarball itself on 2026-10-29. The bundled pjproject (2.17) is fetched during
# configure and checked against the MD5 that this verified tarball ships.
FROM debian:bookworm-slim AS build
ARG ASTERISK_VERSION=22.11.0
ARG ASTERISK_SHA256=3bd5ee040509a3d3cd9b1ba9520c18e6ec0a7e7981ca68c457dcd36ba3c54d94
# Parallel compile jobs: 2 of the host's 6 shared vCPUs, so the neighbours keep theirs.
ARG MAKE_JOBS=2
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl wget bzip2 patch file pkg-config python3 \
      libedit-dev libjansson-dev libssl-dev libsqlite3-dev libxml2-dev uuid-dev libcurl4-openssl-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSLo asterisk.tar.gz \
      "https://downloads.asterisk.org/pub/telephony/asterisk/releases/asterisk-${ASTERISK_VERSION}.tar.gz" \
 && echo "${ASTERISK_SHA256}  asterisk.tar.gz" | sha256sum -c - \
 && tar -xzf asterisk.tar.gz --strip-components=1 && rm asterisk.tar.gz
# make install creates a real /out/var/run; in the runtime image /var/run is a symlink to /run, and
# the COPY below would collide with it, so it is dropped here and made through the symlink there.
RUN ./configure --with-pjproject-bundled --without-x11 --without-gtk2 \
 && make menuselect.makeopts \
 && menuselect/menuselect --disable BUILD_NATIVE --enable chan_websocket --enable chan_pjsip \
      --enable res_pjsip_outbound_registration --enable res_ari --enable res_ari_channels \
      --enable res_ari_bridges --enable res_stasis --enable app_stasis --enable codec_alaw \
      --enable codec_ulaw --disable-category MENUSELECT_CORE_SOUNDS \
      --disable-category MENUSELECT_MOH --disable-category MENUSELECT_EXTRA_SOUNDS \
      menuselect.makeopts \
 && make -j"${MAKE_JOBS}" && make install DESTDIR=/out \
 && rm -rf /out/var/run

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates libedit2 libjansson4 libssl3 libsqlite3-0 libxml2 libuuid1 libcurl4 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 1500 asterisk && useradd --uid 1500 --gid 1500 --home-dir /var/lib/asterisk \
      --shell /usr/sbin/nologin asterisk
COPY --from=build /out/ /
# Fail the build, not the first call, when a module needs a library this stage lacks.
RUN ldconfig \
 && ! { ldd /usr/sbin/asterisk /usr/lib/libasterisk*.so* /usr/lib/asterisk/modules/*.so 2>&1 \
        | grep -F 'not found'; }
RUN mkdir -p /var/lib/asterisk /var/spool/asterisk /var/log/asterisk /var/run/asterisk \
 && chown -R 1500:1500 /var/lib/asterisk /var/spool/asterisk /var/log/asterisk /var/run/asterisk
USER 1500:1500
CMD ["/usr/sbin/asterisk", "-f"]
