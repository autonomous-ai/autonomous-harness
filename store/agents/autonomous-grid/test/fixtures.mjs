// Explicit test data, never a fallback used by the shipped viewer.
export const config = { spec:1, mode:'remote', grid:'test-grid', controller:'local', machines:[{id:'local',name:'Test workstation',transport:'local'}], preferences:{goal:'Coding and quiet chat',keepFreeMemoryGb:8,allowAutomaticChanges:false} };
export const remoteNodes = [
  { node_id:'studio-a',name:'Mac Studio',engine:'llama.cpp',chip:'Apple M4 Max',platform:'macos-arm64',online:true,models:['qwen3.5-27b'],vram_gb:64,vram_used_mb:32768,gpu_temp_c:null,gpu_util_pct:73,gpu_power_w:62,throughput_tok_s:42.8,disk_total_gb:1000,disk_used_gb:482,max_concurrency:4,answered:{window_seconds:86400,tokens_in:120000,tokens_cached:22000,tokens_out:46000,requests:218},model_capabilities:{'qwen3.5-27b':{context_length:32768}} },
  { node_id:'rtx-a',name:'GPU workstation',engine:'vllm',chip:'NVIDIA RTX 4090',platform:'linux-x86_64',online:true,models:['qwen3.5-9b'],vram_gb:24,vram_used_mb:15155,gpu_temp_c:67,gpu_util_pct:86,gpu_power_w:274,gpu_power_limit_w:450,throughput_tok_s:109.4,disk_total_gb:2000,disk_used_gb:1142,max_concurrency:8 },
  { node_id:'mini-a',name:'Mac mini',engine:'mlx',chip:'Apple M4 Pro',platform:'macos-arm64',online:true,models:['gemma-3-4b'],vram_gb:24,vram_used_mb:6042,gpu_util_pct:28,throughput_tok_s:51.6,max_concurrency:2 },
  { node_id:'laptop-a',name:'MacBook Pro',engine:'llama.cpp',chip:'Apple M3 Pro',platform:'macos-arm64',online:true,models:['qwen2.5-coder-7b'],vram_gb:36,vram_used_mb:8320,gpu_util_pct:11,throughput_tok_s:27.3,max_concurrency:1 },
  { node_id:'a6000-a',name:'Inference server',engine:'vllm',chip:'NVIDIA RTX A6000',platform:'linux-x86_64',online:true,models:['qwen3.5-27b'],vram_gb:48,vram_used_mb:34201,gpu_temp_c:72,gpu_util_pct:93,gpu_power_w:247,gpu_power_limit_w:300,throughput_tok_s:68.2,max_concurrency:8 },
  { node_id:'linux-a',name:'Linux box',engine:'llama.cpp',chip:'NVIDIA RTX 3090',platform:'linux-x86_64',online:true,models:['qwen3.5-9b'],vram_gb:24,vram_used_mb:14643,gpu_temp_c:54,gpu_util_pct:47,gpu_power_w:151,throughput_tok_s:72.1,max_concurrency:4 },
  { node_id:'studio-b',name:'Studio · lab',engine:'mlx',chip:'Apple M3 Ultra',platform:'macos-arm64',online:true,models:['qwen3.5-27b','gemma-3-4b'],vram_gb:96,vram_used_mb:36864,gpu_util_pct:36,throughput_tok_s:61.2,max_concurrency:4 },
  { node_id:'pro-a',name:'Mac Pro',engine:'llama.cpp',chip:'Apple M2 Ultra',platform:'macos-arm64',online:false,models:['qwen2.5-coder-7b'],vram_gb:128,vram_used_mb:0,gpu_util_pct:0,throughput_tok_s:31.5,max_concurrency:4 },
];
export const device = { backend:'metal',machine:{model:'Mac Studio',platform:'macos-arm64'},cpu:{brand:'Apple M4 Max',physical_cores:16,logical_threads:16},memory:{total_gb:64,available_gb:28},disk:{total_gb:1000,free_gb:518},usable_bytes:24*1024**3,gpus:[{name:'Apple M4 Max',memory_total_mb:65536}] };
export const reads = {
  info:{ok:true,value:{grid:'Home lab',grid_url:'https://grid.example.test/relay/v1?token=do-not-expose'}},
  engines:{ok:true,value:remoteNodes},
  models:{ok:true,value:[{model:'Qwen3.5-27B'},{model:'Qwen3.5-9B'},{model:'Gemma-3-4B'},{model:'Qwen2.5-Coder-7B'}]},
  stats:{ok:true,value:{answered:{window_seconds:86400,tokens_in:580000,tokens_cached:73000,tokens_out:231840,requests:1482},uptime_pct:99.97,parallel:24}},
};
