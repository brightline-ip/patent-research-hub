import json, sys, textwrap
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.ticker import MaxNLocator
sys.stdin.reconfigure(encoding='utf-8')
data=json.load(sys.stdin)
out=Path(sys.argv[1])
years=[str(r['year']) for r in data['series']]
fig, ax=plt.subplots(figsize=(max(10,min(22,len(years)*.5)),5.5))
outcomes=all(isinstance(r.get('issued'),int) and isinstance(r.get('abandoned'),int) for r in data['series'])
if outcomes:
    issued=[r['issued'] for r in data['series']]
    abandoned=[r['abandoned'] for r in data['series']]
    bars_issued=ax.bar(years,issued,color='#176c83',width=.65,label='Issued')
    bars_abandoned=ax.bar(years,abandoned,bottom=issued,color='#d87a4a',width=.65,label='Abandoned')
    counts=[a+b for a,b in zip(issued,abandoned)]
    shares=[r.get('issueSharePercent') for r in data['series']]
    ax2=ax.twinx()
    ax2.plot(years,[float('nan') if x is None else x for x in shares],color='#2f3b52',marker='o',linewidth=1.8,label='Issued share')
    ax2.set_ylabel('Issued share of observed outcomes (%)')
    ax2.set_ylim(0,100)
    ax2.spines['top'].set_visible(False)
    handles,labels=ax.get_legend_handles_labels();handles2,labels2=ax2.get_legend_handles_labels()
    ax.legend(handles+handles2,labels+labels2,loc='upper left',frameon=False,ncol=3)
    ax.set_ylabel('Distinct application outcomes')
else:
    counts=[r['count'] for r in data['series']]
    bars=ax.bar(years,counts,color='#176c83',width=.65)
    unit=data['definition']['unit']
    ax.set_ylabel('Distinct '+(unit+'s' if unit.lower().endswith('number') else unit+' IDs'))
ax.set_xlabel(data['definition']['dateBasis'].capitalize()+' year')
ax.set_title('\n'.join(textwrap.wrap(data['title'],95)),loc='left',pad=18)
if len(years)>15:
    for label in ax.get_xticklabels(): label.set_rotation(60); label.set_fontsize(8)
elif not outcomes: ax.bar_label(bars,padding=4)
ax.set_ylim(0,max(counts+[1])*1.18)
ax.yaxis.set_major_locator(MaxNLocator(integer=True))
ax.spines[['top','right']].set_visible(False)
ax.grid(axis='y',alpha=.15);ax.set_axisbelow(True)
fig.text(.08,.02,'\n'.join(textwrap.wrap('Observed dataset only. Snapshot '+data['snapshotDate']+'. Source: '+data['source'],120)),fontsize=9)
fig.tight_layout(rect=[0,.10,1,1])
for extension in ['svg','png']: fig.savefig(out/('chart.'+extension),dpi=170)
plt.close(fig)
