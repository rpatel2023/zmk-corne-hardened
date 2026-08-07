# Hardened Eyelash Corne ZMK Configuration

> [!WARNING]
> **This is NOT the firmware running on the physical keyboard.** This repository
> targets the `nice_nano_v2` / `nice_view` lineage; the board actually in use is
> the OLED lineage, built from **[`rpatel2023/zmk-eyelash-corne`](https://github.com/rpatel2023/zmk-eyelash-corne)**
> (the prod root as of 2026-08-07). Never flash artifacts from this repository
> onto that board. The hardening work done here lives on in the `rpatel2023/zmk-*`
> module forks pinned by the prod repo's `west.yml`, and `tools/edit-firmware/`
> has been ported there.

A reviewed and reproducible ZMK firmware configuration for the Eyelash Peripherals wireless Corne keyboard.

> [!IMPORTANT]
> This keyboard uses a custom PCB and hardware layout. It is **not compatible** with standard firmware for [foostan’s Corne](https://github.com/foostan/crkbd) or the standard ZMK `corne` shield.

![Eyelash Peripherals Corne keyboard](https://ae01.alicdn.com/kf/Sa797fee25edd44248fbfdb0e13d44e00B.jpg)

## Project status

This repository began as a fork of the firmware configuration supplied by the keyboard vendor.

The `vendor-snapshot` branch preserves the vendor configuration as a reference.

The hardening review (formerly the `hardening` branch, now merged into `main`) provided:

* reproducible builds using pinned dependency commits;
* a documented firmware supply chain;
* safer ZMK Studio configuration;
* removal of unnecessary modules;
* reviewed hardware definitions;
* independently built firmware artifacts;
* published checksums for firmware releases.

The review is complete, but this lineage is retired from active use — see the warning at the top of this file.

## Supported hardware

The configuration is intended for the Eyelash Peripherals Corne keyboard using:

* an nRF52840-compatible controller;
* separate left and right wireless halves;
* MX-compatible hot-swap switches;
* displays on both halves;
* an EC11 rotary encoder;
* RGB lighting;
* a pointing-device or joystick input;
* USB and Bluetooth connectivity.

Hardware revisions may differ. Confirm that your PCB matches the pin definitions in this repository before flashing firmware.

## Repository structure

```text
.github/workflows/   GitHub Actions firmware build workflow
boards/shields/      Keyboard hardware and shield definitions
config/              ZMK manifest and user configuration
keymap-drawer/       Generated keymap diagrams
build.yaml           Firmware build targets
```

## Firmware targets

The build configuration currently produces:

* left-half firmware;
* right-half firmware;
* a settings-reset firmware image.

The left half acts as the central side of the split keyboard. The right half connects to it as a wireless peripheral.

## Security and reproducibility goals

The vendor configuration depends on a custom ZMK fork and several external modules. This hardened fork will pin each dependency to a reviewed commit rather than tracking mutable branches such as `main`.

The project will also review:

* ZMK Studio locking;
* custom Studio RPC permissions;
* remotely hosted Studio interfaces;
* Bluetooth profile-management functionality;
* persistent runtime settings;
* GitHub Actions dependencies.

A successful build does not by itself prove that firmware is safe. Releases should identify the exact source commit and include SHA-256 checksums for every firmware artifact.

## Building

Firmware is built using GitHub Actions.

Do not enable or run the build workflow until the dependency manifest on the `hardening` branch has been reviewed and pinned.

Once hardening is complete, build instructions will be added here.

## Flashing warning

Before flashing custom firmware:

1. Verify that the factory firmware works.
2. Confirm that both halves communicate correctly.
3. Keep a known recovery method available.
4. Build firmware from a reviewed commit.
5. Verify the downloaded artifact checksum.
6. Flash only the image intended for the correct keyboard half.

Flashing incorrect hardware definitions may cause keys, displays, RGB lighting, the encoder, or wireless communication to stop working. Recovery should normally remain possible through the controller’s UF2 bootloader.

## Keymap

![Current keymap diagram](keymap-drawer/eyelash_corne.svg "Eyelash Corne keymap")

## Attribution

The original hardware definitions and vendor configuration were published in:

* [`a741725193/zmk-new_corne`](https://github.com/a741725193/zmk-new_corne)

This fork retains the original project history while independently reviewing and hardening the build configuration.

ZMK is maintained by the [ZMK Firmware project](https://github.com/zmkfirmware/zmk).
