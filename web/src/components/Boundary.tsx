"use client";
import { Component, type ReactNode } from "react";

/** Wraps every block that renders engine data, so one bad payload cannot take the page down. */
export class Boundary extends Component<{ children: ReactNode; label?: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <div className="empty">
          <b>This block could not be drawn</b>
          {this.props.label ?? "The data arrived in a shape the page did not expect."} Reload to try again.
        </div>
      );
    return this.props.children;
  }
}
