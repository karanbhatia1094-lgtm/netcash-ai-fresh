@echo off
set NODE_ENV=development
set NODE_TLS_REJECT_UNAUTHORIZED=0
set HOST=127.0.0.1
set HTTP_PROXY=
set HTTPS_PROXY=
set ALL_PROXY=
npx remix dev
