"""로컬 정적 서버 (표준 라이브러리만 사용).

`python3 -m http.server`와 같지만, 대기열(backlog)을 늘려 브라우저가 ES 모듈 여러 개를
동시에 요청할 때 연결이 끊기는(ERR_CONNECTION_RESET) 문제를 피한다.
사용: python3 scripts/serve.py [포트]   (기본 8000, 127.0.0.1에만 열림)
"""
import functools
import http.server
import os
import sys


class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 128
    daemon_threads = True


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
    handler.extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript"}
    with Server(("127.0.0.1", port), handler) as httpd:
        print(f"http://localhost:{port}/ 에서 실행 중 (종료: Ctrl+C)")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
