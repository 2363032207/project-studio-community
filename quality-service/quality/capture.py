"""可选 ADB 日志抓取入口，不清空设备日志、不自动选择设备、不安装设备软件。"""

import argparse
import re
import shutil
import subprocess
from pathlib import Path


def capture(serial, package, duration, output, adb="adb"):
    """作用：抓取指定设备游戏进程日志；入参：序列号、包名、秒数、路径、ADB；返回：生成的日志路径。"""
    if not re.fullmatch(r"[A-Za-z0-9_.]+",package) or not 1 <= duration <= 600:
        raise ValueError("包名格式不正确，或抓取时长不在 1~600 秒")
    executable=shutil.which(adb)
    if not executable:
        raise ValueError("未找到 ADB，请安装 Android Platform Tools 后加入 PATH")
    process_ids=subprocess.check_output([executable,"-s",serial,"shell","pidof",package],timeout=10,text=True).split()
    if not process_ids or not process_ids[0].isdigit():
        raise ValueError("游戏尚未运行，未发现目标进程")
    output=Path(output)
    if output.exists():
        raise ValueError("输出文件已存在，请选择新的文件名")
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open("xb") as destination:
        process=subprocess.Popen([executable,"-s",serial,"logcat","-T","1","-v","threadtime","--pid",process_ids[0]],
            stdout=destination,stderr=subprocess.PIPE)
        try:
            _, errors=process.communicate(timeout=duration)
            if process.returncode:
                raise ValueError("ADB 抓取失败："+errors.decode("utf-8",errors="replace")[:500])
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
    return output


def main():
    """作用：提供设备日志抓取命令；入参：命令行参数；返回：打印日志路径。"""
    parser=argparse.ArgumentParser(description="抓取个人游戏进程日志，设备需提前授权 USB 调试")
    parser.add_argument("--serial",required=True)
    parser.add_argument("--package",required=True)
    parser.add_argument("--duration",type=int,default=60)
    parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args()
    print(capture(args.serial,args.package,args.duration,args.output))


if __name__=="__main__":
    main()
