{{/* Standard names and labels. */}}
{{- define "mates.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "mates.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "mates.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "mates.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "mates.selectorLabels" -}}
app.kubernetes.io/name: {{ include "mates.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "mates.apiImage" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{- define "mates.runnerImage" -}}
{{ .Values.runner.image.repository }}:{{ .Values.runner.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{- define "mates.publicUrl" -}}
{{- if .Values.publicUrl -}}
{{ .Values.publicUrl }}
{{- else if and .Values.ingress.enabled .Values.ingress.host -}}
{{ printf "%s://%s" (ternary "https" "http" (gt (len .Values.ingress.tls) 0)) .Values.ingress.host }}
{{- else -}}
{{ printf "http://%s.%s.svc:%d" (include "mates.fullname" .) .Release.Namespace (int .Values.service.port) }}
{{- end -}}
{{- end -}}

{{/* Environment entries that resolve the database URL. */}}
{{- define "mates.databaseEnv" -}}
{{- if .Values.postgresql.enabled }}
- name: POSTGRES_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "mates.fullname" . }}-postgresql
      key: password
- name: DATABASE_URL
  value: "postgres://{{ .Values.postgresql.auth.username }}:$(POSTGRES_PASSWORD)@{{ include "mates.fullname" . }}-postgresql:5432/{{ .Values.postgresql.auth.database }}"
{{- else if .Values.externalDatabase.existingSecret }}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.externalDatabase.existingSecret }}
      key: {{ .Values.externalDatabase.key }}
{{- else }}
- name: DATABASE_URL
  value: {{ required "externalDatabase.url is required when postgresql.enabled=false" .Values.externalDatabase.url | quote }}
{{- end }}
{{- end -}}

{{/* Environment shared by the API deployment and the migration job. */}}
{{- define "mates.commonEnv" -}}
{{ include "mates.databaseEnv" . }}
- name: MATES_RELEASE
  value: {{ include "mates.fullname" . | quote }}
- name: MATES_NAMESPACE
  value: {{ .Release.Namespace | quote }}
- name: LOG_LEVEL
  value: {{ .Values.logLevel | quote }}
- name: MATES_INTERNAL_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "mates.fullname" . }}-internal
      key: internal_key
{{- end -}}
