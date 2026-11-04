param([string]$pids)
$all=Get-CimInstance Win32_Process
$kids=@{}; foreach($p in $all){ if(-not $kids.ContainsKey($p.ParentProcessId)){ $kids[$p.ParentProcessId]=@() }; $kids[$p.ParentProcessId]+=$p }
$seen=@{}; $q=New-Object Collections.Queue
foreach($x in ($pids -split ',')){ $r=$all | ?{ $_.ProcessId -eq [int]$x }; if($r){ $q.Enqueue($r) } }
$sum=0;$names=@{}
while($q.Count){ $p=$q.Dequeue(); if($seen[$p.ProcessId]){continue}; $seen[$p.ProcessId]=1; $sum+=$p.WorkingSetSize; $names[$p.Name]=1+[int]$names[$p.Name]; foreach($c in $kids[$p.ProcessId]){ $q.Enqueue($c) } }
$fmt=($names.GetEnumerator() | sort Name | %{ "$($_.Name)x$($_.Value)" }) -join ' '
"工作集合計 {0:N0} MB；{1}" -f ($sum/1MB),$fmt
