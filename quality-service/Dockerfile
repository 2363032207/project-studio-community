FROM python:3.12-slim
WORKDIR /app
COPY requirements-perfetto.txt ./
COPY quality/install_perfetto.py ./install_perfetto.py
ARG WITH_PERFETTO=true
RUN if [ "$WITH_PERFETTO" = "true" ]; then \
      pip install --no-cache-dir -r requirements-perfetto.txt && \
      python install_perfetto.py /opt/perfetto/trace_processor_shell; \
    fi
COPY quality ./quality
RUN useradd --uid 10001 --create-home analyzer && mkdir /data && chown analyzer:analyzer /data
USER analyzer
ENV PYTHONUNBUFFERED=1 QUALITY_HOST=0.0.0.0 QUALITY_DATA_DIR=/data TRACE_PROCESSOR_PATH=/opt/perfetto/trace_processor_shell
EXPOSE 8090
CMD ["python", "-m", "quality.server"]
