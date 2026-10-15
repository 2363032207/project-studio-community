"""用官方 protobuf 类型生成小型二进制 Trace，只用于解析器验证。"""

import sys
from pathlib import Path


def generate(destination):
    """作用：生成含进程、帧与 GC 的二进制 Trace；入参：输出路径；返回：Path。"""
    from perfetto.protos.perfetto.trace.perfetto_trace_pb2 import Trace
    trace = Trace()
    process = trace.packet.add()
    process.track_descriptor.uuid = 1
    process.track_descriptor.process.pid = 123
    process.track_descriptor.process.process_name = "com.example.game"
    thread = trace.packet.add()
    thread.track_descriptor.uuid = 2
    thread.track_descriptor.parent_uuid = 1
    thread.track_descriptor.thread.pid = 123
    thread.track_descriptor.thread.tid = 123
    thread.track_descriptor.thread.thread_name = "MainThread"
    for index in range(100):
        start = trace.packet.add()
        start.timestamp = 1_000_000_000 + index * 16_667_000
        start.trusted_packet_sequence_id = 1
        if index == 0:
            start.sequence_flags = 1
        start.track_event.track_uuid = 2
        start.track_event.type = 1
        start.track_event.name = "PlayerLoop"
        end = trace.packet.add()
        end.timestamp = start.timestamp + 15_000_000
        end.trusted_packet_sequence_id = 1
        end.track_event.track_uuid = 2
        end.track_event.type = 2
    output = Path(destination)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(trace.SerializeToString())
    return output


if __name__ == "__main__":
    print(generate(sys.argv[1] if len(sys.argv)>1 else "data/samples/demo.perfetto-trace"))
