import { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import type { BenchmarkResult } from '../App';

interface HashRateChartProps {
  results: BenchmarkResult[];
}

export default function HashRateChart({ results }: HashRateChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || results.length === 0) return;

    const container = containerRef.current;
    const svg = d3.select(svgRef.current);

    // Clear previous content
    svg.selectAll('*').remove();

    // Dimensions
    const margin = { top: 40, right: 120, bottom: 60, left: 140 };
    const width = container.clientWidth - margin.left - margin.right;
    const height = Math.max(200, results.length * 80);

    svg.attr('width', width + margin.left + margin.right)
       .attr('height', height + margin.top + margin.bottom);

    const g = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Use logarithmic scale due to massive difference between GPU and CPU
    const maxHashrate = d3.max(results, d => d.hashrate) || 1;
    const xScale = d3.scaleLog()
      .domain([1, maxHashrate * 2])
      .range([0, width])
      .clamp(true);

    const yScale = d3.scaleBand()
      .domain(results.map(d => d.name))
      .range([0, height])
      .padding(0.4);

    // Grid lines
    g.append('g')
      .attr('class', 'grid')
      .attr('transform', `translate(0,${height})`)
      .call(
        d3.axisBottom(xScale)
          .ticks(5, '~s')
          .tickSize(-height)
      )
      .call(g => g.select('.domain').remove())
      .call(g => g.selectAll('.tick line')
        .attr('stroke', 'rgba(255,255,255,0.1)')
      )
      .call(g => g.selectAll('.tick text')
        .attr('fill', 'rgba(255,255,255,0.5)')
        .attr('font-size', '12px')
      );

    // Bars
    const bars = g.selectAll('.bar')
      .data(results)
      .enter()
      .append('g')
      .attr('class', 'bar');

    // Bar background (glass effect)
    bars.append('rect')
      .attr('x', 0)
      .attr('y', d => yScale(d.name)!)
      .attr('width', width)
      .attr('height', yScale.bandwidth())
      .attr('fill', 'rgba(255,255,255,0.03)')
      .attr('rx', 8);

    // Actual bar with gradient
    bars.append('rect')
      .attr('x', 0)
      .attr('y', d => yScale(d.name)!)
      .attr('width', 0)
      .attr('height', yScale.bandwidth())
      .attr('fill', d => d.color)
      .attr('rx', 8)
      .attr('opacity', 0.9)
      .transition()
      .duration(1000)
      .ease(d3.easeCubicOut)
      .attr('width', d => Math.max(0, xScale(Math.max(1, d.hashrate))));

    // Y axis labels
    g.append('g')
      .call(d3.axisLeft(yScale))
      .call(g => g.select('.domain').remove())
      .call(g => g.selectAll('.tick line').remove())
      .call(g => g.selectAll('.tick text')
        .attr('fill', 'rgba(255,255,255,0.8)')
        .attr('font-size', '14px')
        .attr('font-weight', '500')
      );

    // Value labels
    bars.append('text')
      .attr('x', d => Math.max(0, xScale(Math.max(1, d.hashrate))) + 10)
      .attr('y', d => yScale(d.name)! + yScale.bandwidth() / 2)
      .attr('dy', '0.35em')
      .attr('fill', 'rgba(255,255,255,0.9)')
      .attr('font-size', '13px')
      .attr('font-weight', '600')
      .attr('opacity', 0)
      .text(d => formatHashrate(d.hashrate))
      .transition()
      .delay(500)
      .duration(500)
      .attr('opacity', 1);

    // Title
    svg.append('text')
      .attr('x', margin.left + width / 2)
      .attr('y', 24)
      .attr('text-anchor', 'middle')
      .attr('fill', 'rgba(255,255,255,0.9)')
      .attr('font-size', '18px')
      .attr('font-weight', '600')
      .text('Hashrate Comparison (logarithmic scale)');

    // X axis label
    svg.append('text')
      .attr('x', margin.left + width / 2)
      .attr('y', height + margin.top + 50)
      .attr('text-anchor', 'middle')
      .attr('fill', 'rgba(255,255,255,0.5)')
      .attr('font-size', '12px')
      .text('Hashes per second (log scale)');

  }, [results]);

  return (
    <div className="glass-card p-6">
      <div ref={containerRef} className="w-full overflow-x-auto">
        <svg ref={svgRef} className="w-full" />
      </div>

      {/* Legend */}
      <div className="flex flex-wrap justify-center gap-6 mt-6 pt-4 border-t border-white/10">
        {results.map((result) => (
          <div key={result.name} className="flex items-center gap-2">
            <div
              className="w-4 h-4 rounded"
              style={{ backgroundColor: result.color }}
            />
            <span className="text-white/70 text-sm">{result.name}</span>
            <span className="text-white/50 text-sm font-mono">
              ({formatHashrate(result.hashrate)})
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatHashrate(hashrate: number): string {
  if (hashrate >= 1e9) {
    return `${(hashrate / 1e9).toFixed(2)} GH/s`;
  } else if (hashrate >= 1e6) {
    return `${(hashrate / 1e6).toFixed(2)} MH/s`;
  } else if (hashrate >= 1e3) {
    return `${(hashrate / 1e3).toFixed(2)} KH/s`;
  }
  return `${hashrate.toFixed(2)} H/s`;
}
